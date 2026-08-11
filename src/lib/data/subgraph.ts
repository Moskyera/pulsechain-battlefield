/**
 * PulseX subgraph client (server-side).
 *
 * Role: independent on-chain confirmation of reserves / cumulative volume, and
 * a secondary swap feed with the indexer's own USD valuation.
 *
 * Two things were learned probing the live indexer and are encoded here:
 *
 *  1. Most established pairs (including all five defaults) live in the **V1**
 *     subgraph, not V2. `pair(id:)` returns null for a miss, so we probe V2
 *     first and fall back to V1, caching the answer per address.
 *
 *  2. The flat `swaps(where: { pair: ... })` filter reliably hits the indexer's
 *     statement timeout. Traversing `pair(id:) { swaps(...) }` returns the same
 *     data in ~2s. Only the traversal form is used.
 *
 * The subgraph is treated as strictly optional. If it is down, slow, or lagging,
 * the battlefield keeps running on RPC + DexScreener and the HUD marks the
 * source degraded.
 */

import { SUBGRAPH_V1, SUBGRAPH_V2 } from '../chain/constants';
import type { SubgraphPair } from './types';

export type SubgraphVersion = 'v1' | 'v2';

const ENDPOINTS: Record<SubgraphVersion, string> = {
  v2: SUBGRAPH_V2,
  v1: SUBGRAPH_V1,
};

const REQUEST_TIMEOUT_MS = 12_000;

export class SubgraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubgraphError';
  }
}

interface GqlResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function query<T>(version: SubgraphVersion, gql: string, variables?: Record<string, unknown>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINTS[version], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: gql, variables }),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) throw new SubgraphError(`${version} subgraph responded ${res.status}`);
    const json = (await res.json()) as GqlResponse<T>;
    if (json.errors?.length) {
      throw new SubgraphError(`${version} subgraph: ${json.errors[0].message.split('\n')[0]}`);
    }
    if (!json.data) throw new SubgraphError(`${version} subgraph returned no data`);
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

/** Which subgraph indexes a given pair. Cached — a pair never changes factory. */
const versionCache = new Map<string, SubgraphVersion | 'none'>();

const PAIR_FIELDS = `
  id
  reserve0
  reserve1
  reserveUSD
  volumeUSD
  token0Price
  token1Price
  totalTransactions
`;

const toNum = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
};

interface RawPair {
  id: string;
  reserve0: string;
  reserve1: string;
  reserveUSD: string;
  volumeUSD: string;
  token0Price: string;
  token1Price: string;
  totalTransactions: string;
}

interface PairQueryResult {
  pair: RawPair | null;
  _meta: { block: { number: number } } | null;
}

/**
 * Fetch a pair's indexed state. Probes V2 then V1 on first sight of an address.
 * Returns null when neither subgraph knows the pair (common for non-PulseX DEXs).
 */
export async function fetchSubgraphPair(pairAddress: string): Promise<SubgraphPair | null> {
  const id = pairAddress.toLowerCase();
  const gql = `query Pair($id: ID!) { pair(id: $id) { ${PAIR_FIELDS} } _meta { block { number } } }`;

  const cached = versionCache.get(id);
  const order: SubgraphVersion[] =
    cached === 'v1' ? ['v1'] : cached === 'v2' ? ['v2'] : cached === 'none' ? [] : ['v2', 'v1'];

  if (order.length === 0) return null;

  let lastError: unknown = null;
  for (const version of order) {
    try {
      const data = await query<PairQueryResult>(version, gql, { id });
      if (data.pair) {
        versionCache.set(id, version);
        return {
          version,
          reserve0: toNum(data.pair.reserve0),
          reserve1: toNum(data.pair.reserve1),
          reserveUSD: toNum(data.pair.reserveUSD),
          volumeUSD: toNum(data.pair.volumeUSD),
          token0Price: toNum(data.pair.token0Price),
          token1Price: toNum(data.pair.token1Price),
          totalTransactions: toNum(data.pair.totalTransactions),
          blockNumber: data._meta?.block?.number ?? 0,
        };
      }
    } catch (err) {
      lastError = err;
    }
  }

  // Both probes came back clean but empty -> the pair genuinely isn't indexed.
  if (!lastError && !cached) versionCache.set(id, 'none');
  if (lastError) throw lastError;
  return null;
}

export interface SubgraphSwap {
  id: string;
  txHash: string;
  logIndex: number;
  timestamp: number;
  amount0In: number;
  amount1In: number;
  amount0Out: number;
  amount1Out: number;
  amountUSD: number;
  to: string;
  from: string;
}

interface RawSwap {
  id: string;
  timestamp: string;
  amount0In: string;
  amount1In: string;
  amount0Out: string;
  amount1Out: string;
  amountUSD: string;
  to: string;
  from: string;
  logIndex: string | null;
  transaction: { id: string };
}

/**
 * Recent swaps for a pair, newest first.
 *
 * Uses the `pair(id:) { swaps }` traversal — see the module note on why the
 * flat `where` filter is avoided.
 */
export async function fetchSubgraphSwaps(
  pairAddress: string,
  limit = 40,
): Promise<{ version: SubgraphVersion; swaps: SubgraphSwap[] } | null> {
  const id = pairAddress.toLowerCase();
  let version = versionCache.get(id);

  if (version === undefined) {
    // Resolve which subgraph holds it first; that call is cheap and cached.
    await fetchSubgraphPair(id).catch(() => null);
    version = versionCache.get(id);
  }
  if (version === undefined || version === 'none') return null;

  const gql = `
    query PairSwaps($id: ID!, $limit: Int!) {
      pair(id: $id) {
        swaps(first: $limit, orderBy: timestamp, orderDirection: desc) {
          id
          timestamp
          amount0In
          amount1In
          amount0Out
          amount1Out
          amountUSD
          to
          from
          logIndex
          transaction { id }
        }
      }
    }
  `;

  const data = await query<{ pair: { swaps: RawSwap[] } | null }>(version, gql, { id, limit });
  const raw = data.pair?.swaps ?? [];

  return {
    version,
    swaps: raw.map((s) => {
      // Entity ids are `${txHash}-${logIndex}`; prefer the explicit field when present.
      const dash = s.id.lastIndexOf('-');
      const idxFromId = dash >= 0 ? Number.parseInt(s.id.slice(dash + 1), 10) : NaN;
      return {
        id: s.id,
        txHash: s.transaction?.id ?? s.id.slice(0, Math.max(0, dash)),
        logIndex: Number.isFinite(Number(s.logIndex))
          ? Number(s.logIndex)
          : Number.isFinite(idxFromId)
            ? idxFromId
            : 0,
        timestamp: toNum(s.timestamp),
        amount0In: toNum(s.amount0In),
        amount1In: toNum(s.amount1In),
        amount0Out: toNum(s.amount0Out),
        amount1Out: toNum(s.amount1Out),
        amountUSD: toNum(s.amountUSD),
        to: s.to ?? '',
        from: s.from ?? '',
      };
    }),
  };
}

/** Indexing head of a subgraph, used to report lag against the chain head. */
export async function fetchSubgraphHead(
  version: SubgraphVersion,
): Promise<{ blockNumber: number; timestamp: number; hasErrors: boolean }> {
  const data = await query<{
    _meta: { block: { number: number; timestamp: number }; hasIndexingErrors: boolean };
  }>(version, '{ _meta { block { number timestamp } hasIndexingErrors } }');
  return {
    blockNumber: data._meta.block.number,
    timestamp: data._meta.block.timestamp,
    hasErrors: data._meta.hasIndexingErrors,
  };
}
