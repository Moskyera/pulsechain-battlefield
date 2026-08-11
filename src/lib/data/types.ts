/**
 * Shared shapes for the data layer.
 *
 * Everything here describes REAL, observed on-chain or aggregator data.
 * There is deliberately no "simulated" or "demo" variant of any of these types —
 * if a field cannot be sourced from the chain or from DexScreener, it is
 * `null`, not invented.
 */

export type Side = 'buy' | 'sell';

/** Unit class, decided purely by the USD size of a real swap. */
export type UnitTier = 'infantry' | 'tank' | 'artillery' | 'nuke';

export type SourceId = 'dexscreener' | 'rpc' | 'websocket' | 'subgraph';

export type SourceState = 'idle' | 'connecting' | 'live' | 'degraded' | 'error';

export interface SourceStatus {
  state: SourceState;
  /** ms epoch of the last successful response. */
  lastOkAt: number | null;
  /** Last error message, if the source is unhealthy. */
  error: string | null;
  /** Free-form detail shown in the HUD, e.g. block height or latency. */
  detail: string | null;
}

/** On-chain token identity, read from the token contract itself. */
export interface TokenMeta {
  address: string;
  symbol: string;
  decimals: number;
}

/**
 * Everything we know about a pool contract, read directly from the chain.
 * `token0`/`token1` are the AMM's own ordering.
 */
export interface PoolMeta {
  address: string;
  token0: TokenMeta;
  token1: TokenMeta;
  /** Factory address reported by the pool, used to label PulseX V1 vs V2. */
  factory: string | null;
  /** How this pool's holdings must be read — see lib/chain/pool.ts. */
  reserveMode: 'getReserves' | 'balanceOf';
  /** DexScreener's dexId, e.g. "pulsex", "9mm", "liberty-swap". */
  dexId: string;
  dexLabel: string;
}

/**
 * Live reserves, read from `getReserves()` at a specific block.
 *
 * Raw values are carried as decimal strings so the exact uint112 survives the
 * JSON hop from the API route to the browser without bigint serialisation games.
 */
export interface Reserves {
  reserve0Raw: string;
  reserve1Raw: string;
  /** Human-scaled amounts (already divided by 10^decimals). */
  amount0: number;
  amount1: number;
  blockNumber: number;
  fetchedAt: number;
  /**
   * How the reserves were obtained: a `getReserves()` call, the pool's ERC-20
   * balances (V3-style pools), or a pushed `Sync` event.
   */
  origin: 'eth_call' | 'balance-of' | 'sync-event';
}

/** DexScreener pair snapshot, trimmed to the fields the battlefield consumes. */
export interface MarketSnapshot {
  pairAddress: string;
  dexId: string;
  /** DexScreener version markers, e.g. ["v2"] or ["V3"]. */
  labels: string[];
  url: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd: number | null;
  priceNative: number | null;
  liquidityUsd: number | null;
  liquidityBase: number | null;
  liquidityQuote: number | null;
  fdv: number | null;
  marketCap: number | null;
  volume: { m5: number; h1: number; h6: number; h24: number };
  priceChange: { m5: number; h1: number; h6: number; h24: number };
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  pairCreatedAt: number | null;
  fetchedAt: number;
}

/**
 * A single real swap, normalised from an on-chain log or the subgraph.
 *
 * `id` is `${txHash}-${logIndex}` so the same swap arriving from two sources
 * (backfill + websocket, or subgraph + RPC) de-duplicates cleanly.
 *
 * `side` is always expressed relative to the battlefield's **focus token**:
 * a BUY means the focus token left the pool (the trader acquired it). In a
 * multi-pool battlefield that keeps every venue's flow directly comparable,
 * whether the focus token sits on the base or the quote side of that pool.
 */
export interface RealSwap {
  id: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** Unix seconds. From the block for RPC swaps, from the entity for subgraph swaps. */
  timestamp: number;
  poolAddress: string;
  /** Which DEX the pool belongs to, e.g. "PulseX V2", "9mm". */
  dexLabel: string;
  side: Side;
  /** Amount of the focus token that changed hands, human-scaled. */
  focusAmount: number;
  /** Amount of the counter token that changed hands, human-scaled. */
  counterAmount: number;
  /** USD notional. Null when no price is available yet — never guessed. */
  usd: number | null;
  focusSymbol: string;
  counterSymbol: string;
  trader: string;
  tier: UnitTier;
  source: 'websocket' | 'rpc-backfill' | 'subgraph';
  /** Which log shape this came from, for provenance display. */
  amm: 'v2' | 'v3';
}

export interface WarToken {
  address: string;
  symbol: string;
}

/**
 * What the user chose to fight over.
 *
 * `war` is the headline mode: several tokens' pools merged into one theatre, so
 * the field carries the whole ecosystem's flow instead of a single coin's.
 * Tokens are listed in priority order — see `resolveBattleGroup` for how a pool
 * holding two war tokens picks its side.
 */
export type BattleTarget =
  | { kind: 'war'; id: string; label: string; tokens: WarToken[] }
  | { kind: 'token'; address: string; symbol: string }
  | { kind: 'pool'; address: string; label: string };

/** One pool enlisted into a battlefield, with everything needed to price it. */
export interface PoolEnlistment {
  meta: PoolMeta;
  reserves: Reserves;
  market: MarketSnapshot | null;
  /** Which token this pool is scored on. */
  focusAddress: string;
  focusSymbol: string;
  /** True when the focus token is this pool's token0. */
  focusIsToken0: boolean;
  /** USD value of the focus-token leg of this pool's holdings. */
  focusReserveUsd: number | null;
  /** USD value of the counter-token leg. */
  counterReserveUsd: number | null;
}

/** Aggregated buy/sell pressure over a rolling window of real swaps. */
export interface PressureWindow {
  windowSec: number;
  buyUsd: number;
  sellUsd: number;
  buyCount: number;
  sellCount: number;
  /** -1 (all sells) .. +1 (all buys). Null when the window has no swaps. */
  ratio: number | null;
}

export interface SubgraphPair {
  version: 'v1' | 'v2';
  reserve0: number;
  reserve1: number;
  reserveUSD: number;
  volumeUSD: number;
  token0Price: number;
  token1Price: number;
  totalTransactions: number;
  blockNumber: number;
}
