/**
 * DexScreener client (server-side).
 *
 * Supplies the USD layer: token price, liquidity, rolling volume and the
 * aggregator's own buy/sell transaction counts. Combined with on-chain reserves
 * this is what prices every individual swap in dollars.
 *
 * Documented rate limits are 300 req/min for /latest/dex/* and 60 req/min for
 * the /tokens and /token-pairs endpoints. Every response is cached briefly and
 * concurrent identical requests are de-duplicated, so N open tabs cost the same
 * as one.
 */

import { DEXSCREENER_BASE, DEXSCREENER_CHAIN } from '../chain/constants';
import type { MarketSnapshot } from './types';

/** Raw DexScreener pair shape (only the fields we read). */
interface DsPair {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  labels?: string[];
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: Record<string, { buys?: number; sells?: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};

const num0 = (v: unknown): number => num(v) ?? 0;

export function toSnapshot(p: DsPair): MarketSnapshot {
  const t = p.txns ?? {};
  const win = (k: string) => ({ buys: num0(t[k]?.buys), sells: num0(t[k]?.sells) });

  return {
    pairAddress: (p.pairAddress ?? '').toLowerCase(),
    dexId: p.dexId ?? 'unknown',
    labels: Array.isArray(p.labels) ? p.labels : [],
    url: p.url ?? '',
    baseToken: {
      address: (p.baseToken?.address ?? '').toLowerCase(),
      name: p.baseToken?.name ?? '',
      symbol: p.baseToken?.symbol ?? '???',
    },
    quoteToken: {
      address: (p.quoteToken?.address ?? '').toLowerCase(),
      name: p.quoteToken?.name ?? '',
      symbol: p.quoteToken?.symbol ?? '???',
    },
    priceUsd: num(p.priceUsd),
    priceNative: num(p.priceNative),
    liquidityUsd: num(p.liquidity?.usd),
    liquidityBase: num(p.liquidity?.base),
    liquidityQuote: num(p.liquidity?.quote),
    fdv: num(p.fdv),
    marketCap: num(p.marketCap),
    volume: {
      m5: num0(p.volume?.m5),
      h1: num0(p.volume?.h1),
      h6: num0(p.volume?.h6),
      h24: num0(p.volume?.h24),
    },
    priceChange: {
      m5: num0(p.priceChange?.m5),
      h1: num0(p.priceChange?.h1),
      h6: num0(p.priceChange?.h6),
      h24: num0(p.priceChange?.h24),
    },
    txns: { m5: win('m5'), h1: win('h1'), h6: win('h6'), h24: win('h24') },
    pairCreatedAt: num(p.pairCreatedAt),
    fetchedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* Cache + in-flight de-duplication                                    */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  at: number;
  value: unknown;
}
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

export class DexScreenerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DexScreenerError';
  }
}

async function getJson<T>(path: string, ttlMs: number): Promise<T> {
  const now = Date.now();
  const hit = cache.get(path);
  if (hit && now - hit.at < ttlMs) return hit.value as T;

  const pending = inflight.get(path);
  if (pending) return pending as Promise<T>;

  const task = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(DEXSCREENER_BASE + path, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
        cache: 'no-store',
      });

      if (res.status === 429) {
        // Serve stale rather than failing the frame — the HUD flags the source
        // as degraded so the user knows the number is a few seconds old.
        if (hit) return hit.value;
        throw new DexScreenerError('DexScreener rate limit reached', 429);
      }
      if (!res.ok) {
        if (hit) return hit.value;
        throw new DexScreenerError(`DexScreener responded ${res.status}`, res.status);
      }

      const json = await res.json();
      cache.set(path, { at: Date.now(), value: json });
      return json;
    } catch (err) {
      if (hit) return hit.value;
      throw err instanceof DexScreenerError
        ? err
        : new DexScreenerError(err instanceof Error ? err.message : 'DexScreener request failed');
    } finally {
      clearTimeout(timer);
      inflight.delete(path);
    }
  })();

  inflight.set(path, task);
  return task as Promise<T>;
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

/** GET /latest/dex/pairs/pulsechain/{pairAddress} */
export async function fetchPairSnapshot(pairAddress: string): Promise<MarketSnapshot | null> {
  const json = await getJson<{ pairs?: DsPair[] | null; pair?: DsPair | null }>(
    `/latest/dex/pairs/${DEXSCREENER_CHAIN}/${pairAddress}`,
    2_000,
  );
  const p = json.pairs?.[0] ?? json.pair ?? null;
  return p ? toSnapshot(p) : null;
}

/**
 * GET /token-pairs/v1/pulsechain/{tokenAddress} — every pair for one token.
 *
 * Cached for 2.5s to match the battlefield poll rate: this single call keeps an
 * entire multi-pool battlefield priced, and the cache means N clients still
 * cost one outbound request per interval. Documented limit here is 60 req/min.
 */
export async function fetchTokenPairs(tokenAddress: string): Promise<MarketSnapshot[]> {
  const json = await getJson<DsPair[]>(
    `/token-pairs/v1/${DEXSCREENER_CHAIN}/${tokenAddress}`,
    2_500,
  );
  return (Array.isArray(json) ? json : [])
    .filter((p) => p.chainId === DEXSCREENER_CHAIN)
    .map(toSnapshot);
}

/** GET /tokens/v1/pulsechain/{a,b,c} — up to 30 comma-separated addresses. */
export async function fetchTokensPairs(addresses: string[]): Promise<MarketSnapshot[]> {
  if (addresses.length === 0) return [];
  const json = await getJson<DsPair[]>(
    `/tokens/v1/${DEXSCREENER_CHAIN}/${addresses.slice(0, 30).join(',')}`,
    15_000,
  );
  return (Array.isArray(json) ? json : [])
    .filter((p) => p.chainId === DEXSCREENER_CHAIN)
    .map(toSnapshot);
}

/** GET /latest/dex/search?q= — filtered to PulseChain only. */
export async function searchPulseChain(query: string): Promise<MarketSnapshot[]> {
  const json = await getJson<{ pairs?: DsPair[] | null }>(
    `/latest/dex/search?q=${encodeURIComponent(query)}`,
    10_000,
  );
  return (json.pairs ?? [])
    .filter((p) => p.chainId === DEXSCREENER_CHAIN)
    .map(toSnapshot)
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
}
