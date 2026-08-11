/**
 * Turns raw on-chain swap logs into the battlefield's vocabulary.
 *
 * The only inputs are real amounts decoded from `Swap` events and real prices
 * from DexScreener. Nothing here rounds a value up to make an explosion bigger.
 *
 * Two log shapes are handled, decided by the log's own topic and data length
 * rather than by any assumption about the pool:
 *
 *   V2 (128-byte data)  amount0In/amount1In/amount0Out/amount1Out, unsigned
 *   V3 (160-byte data)  amount0/amount1, SIGNED — positive means into the pool
 *
 * Side is always relative to the battlefield's focus token: the focus token
 * leaving a pool means the trader acquired it, which is a BUY.
 */

import { decodeSwapLog, decodeSwapV3Log, formatUnits } from '../chain/abi';
import { SWAP_TOPIC0, SWAP_V3_TOPIC0 } from '../chain/constants';
import type { PoolMeta, RealSwap, Side, UnitTier } from './types';

/**
 * USD cutoffs that decide what a trade becomes on the field.
 *
 * Two scales, because one number does not fit PulseChain.
 *
 * ABSOLUTE is the fixed dollar ladder. It is the honest "what is this trade
 * worth" reading, and it is what you want when comparing chains or venues.
 *
 * ADAPTIVE ranks each trade against the *other real trades on this
 * battlefield*, using live percentiles of observed swap sizes.
 *
 * Why adaptive exists: measured across ~20,000 real swaps over 8.3 hours on
 * the four preset tokens, the median PulseChain trade is **$1.32–$4.85**.
 * Trades over $5,000 arrived roughly once every four hours, and **not one
 * trade exceeded $25,000**. On the fixed ladder the battlefield is therefore
 * ~99% infantry, artillery is a rarity and the nuke tier never fires at all.
 *
 * Adaptive keeps every number real — it changes only which *bucket* a real
 * trade lands in, from "big in dollars" to "big for this market". The HUD
 * always displays the live cutoffs so the basis is never hidden.
 */
export interface TierScale {
  mode: 'absolute' | 'adaptive';
  tank: number;
  artillery: number;
  nuke: number;
  /** How many observed swaps the adaptive cutoffs were derived from. */
  samples: number;
}

export const ABSOLUTE_THRESHOLDS = {
  tank: 500,
  artillery: 5_000,
  nuke: 25_000,
} as const;

export const ABSOLUTE_SCALE: TierScale = {
  mode: 'absolute',
  ...ABSOLUTE_THRESHOLDS,
  samples: 0,
};

/**
 * Percentile cuts used by the adaptive scale.
 *
 * Tuned against the live stream rather than picked for tidiness. PulseChain's
 * trade sizes are extremely skewed — a measured live sample had a median of
 * $0.28 with occasional $200–$500 trades — so an 80th-percentile tank cutoff
 * left the standing battery firing roughly once every ten trades, about twice a
 * minute. The guns read as inert at that rate.
 *
 * At the 55th percentile the battery answers a bit under half of all trades, so
 * armour fires on a steady cadence while the smallest trades still stay small
 * arms. Nothing about the data changes — only which real trade lands in which
 * bucket, and the live cutoffs are always shown in the HUD legend.
 */
export const ADAPTIVE_PERCENTILES = {
  tank: 0.55,
  artillery: 0.88,
  nuke: 0.975,
} as const;

/** Minimum observed swaps before adaptive cutoffs are trustworthy. */
export const ADAPTIVE_MIN_SAMPLES = 40;

/**
 * Derive adaptive cutoffs from observed swap sizes.
 *
 * Falls back to the absolute ladder until enough real trades have been seen,
 * so a fresh battlefield never invents a distribution it hasn't measured.
 */
export function deriveAdaptiveScale(sortedUsd: number[]): TierScale {
  const n = sortedUsd.length;
  if (n < ADAPTIVE_MIN_SAMPLES) return { ...ABSOLUTE_SCALE, mode: 'adaptive', samples: n };

  const at = (p: number) => sortedUsd[Math.min(n - 1, Math.max(0, Math.floor(n * p)))];

  // Keep the ladder strictly increasing even on a degenerate distribution
  // (e.g. a pool where almost every trade is the same size).
  const tank = Math.max(1, at(ADAPTIVE_PERCENTILES.tank));
  const artillery = Math.max(tank * 1.6, at(ADAPTIVE_PERCENTILES.artillery));
  const nuke = Math.max(artillery * 1.8, at(ADAPTIVE_PERCENTILES.nuke));

  return { mode: 'adaptive', tank, artillery, nuke, samples: n };
}

export function tierForUsd(usd: number | null, scale: TierScale = ABSOLUTE_SCALE): UnitTier {
  if (usd === null || !Number.isFinite(usd)) return 'infantry';
  if (usd >= scale.nuke) return 'nuke';
  if (usd >= scale.artillery) return 'artillery';
  if (usd >= scale.tank) return 'tank';
  return 'infantry';
}

/** Back-compat alias for the fixed ladder, used by the legend's absolute mode. */
export const TIER_THRESHOLDS = ABSOLUTE_THRESHOLDS;

export const TIER_LABEL: Record<UnitTier, string> = {
  infantry: 'INFANTRY',
  tank: 'TANK',
  artillery: 'ARTILLERY',
  nuke: 'NUKE',
};

/** Relative visual weight of each tier — drives scale, speed and blast radius. */
export const TIER_POWER: Record<UnitTier, number> = {
  infantry: 1,
  tank: 2.2,
  artillery: 4,
  nuke: 8,
};

/**
 * Everything needed to interpret one pool's swap logs in focus/counter terms.
 * One of these per enlisted pool; the engine routes each log by its address.
 */
export interface PoolContext {
  meta: PoolMeta;
  focusIsToken0: boolean;
  focusSymbol: string;
  counterSymbol: string;
  focusDecimals: number;
  counterDecimals: number;
  /** USD price of the focus token. Shared across every pool in a battlefield. */
  focusPriceUsd: number | null;
  /** USD price of this pool's counter token, derived per pool. */
  counterPriceUsd: number | null;
  /** Cutoffs in force when this context was built. */
  scale: TierScale;
}

export function buildPoolContext(
  meta: PoolMeta,
  focusTokenAddress: string,
  focusPriceUsd: number | null,
  counterPriceUsd: number | null,
  scale: TierScale = ABSOLUTE_SCALE,
): PoolContext {
  const focus = focusTokenAddress.toLowerCase();
  const focusIsToken0 = meta.token0.address.toLowerCase() === focus;
  const focusToken = focusIsToken0 ? meta.token0 : meta.token1;
  const counterToken = focusIsToken0 ? meta.token1 : meta.token0;

  return {
    meta,
    focusIsToken0,
    focusSymbol: focusToken.symbol,
    counterSymbol: counterToken.symbol,
    focusDecimals: focusToken.decimals,
    counterDecimals: counterToken.decimals,
    focusPriceUsd,
    counterPriceUsd,
    scale,
  };
}

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

/** Signed token deltas from the pool's perspective: positive = entered the pool. */
interface Deltas {
  token0: number;
  token1: number;
  trader: string;
  amm: 'v2' | 'v3';
}

/**
 * Decode a swap log into signed token deltas, whichever AMM emitted it.
 *
 * Returns null for logs that aren't a recognised swap shape, so an unexpected
 * event can never be silently mistaken for a trade.
 */
function decodeDeltas(log: RawLog, meta: PoolMeta): Deltas | null {
  const topic0 = (log.topics[0] ?? '').toLowerCase();
  const dataBytes = (log.data.length - 2) / 2;

  if (topic0 === SWAP_TOPIC0 && dataBytes >= 128) {
    const d = decodeSwapLog(log);
    if (!d) return null;
    return {
      token0: formatUnits(d.amount0In, meta.token0.decimals) - formatUnits(d.amount0Out, meta.token0.decimals),
      token1: formatUnits(d.amount1In, meta.token1.decimals) - formatUnits(d.amount1Out, meta.token1.decimals),
      trader: d.to || d.sender,
      amm: 'v2',
    };
  }

  if (topic0 === SWAP_V3_TOPIC0 && dataBytes >= 160) {
    const d = decodeSwapV3Log(log);
    if (!d) return null;
    // V3 amounts are already signed with "into the pool" positive.
    const scale = (v: bigint, decimals: number) =>
      v < 0n ? -formatUnits(-v, decimals) : formatUnits(v, decimals);
    return {
      token0: scale(d.amount0, meta.token0.decimals),
      token1: scale(d.amount1, meta.token1.decimals),
      trader: d.recipient || d.sender,
      amm: 'v3',
    };
  }

  return null;
}

/**
 * Normalise any swap log into a `RealSwap`, relative to the focus token.
 *
 * The focus token leaving the pool (negative delta) means the trader received
 * it — a BUY. Entering the pool means it was sold.
 */
export function normalizeSwapLog(
  log: RawLog,
  ctx: PoolContext,
  timestamp: number,
  source: RealSwap['source'],
): RealSwap | null {
  const deltas = decodeDeltas(log, ctx.meta);
  if (!deltas) return null;

  const focusDelta = ctx.focusIsToken0 ? deltas.token0 : deltas.token1;
  const counterDelta = ctx.focusIsToken0 ? deltas.token1 : deltas.token0;

  const focusAmount = Math.abs(focusDelta);
  const counterAmount = Math.abs(counterDelta);
  if (focusAmount <= 0 && counterAmount <= 0) return null;

  const side: Side = focusDelta < 0 ? 'buy' : 'sell';

  return finalizeSwap({
    txHash: log.transactionHash,
    logIndex: Number.parseInt(log.logIndex, 16) || 0,
    blockNumber: Number.parseInt(log.blockNumber, 16) || 0,
    timestamp,
    poolAddress: log.address.toLowerCase(),
    side,
    focusAmount,
    counterAmount,
    trader: deltas.trader,
    ctx,
    source,
    amm: deltas.amm,
  });
}

export interface FinalizeInput {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  timestamp: number;
  poolAddress: string;
  side: Side;
  focusAmount: number;
  counterAmount: number;
  trader: string;
  ctx: PoolContext;
  source: RealSwap['source'];
  amm: 'v2' | 'v3';
  /** Subgraph provides its own USD figure; prefer it when present. */
  usdOverride?: number | null;
}

/**
 * Shared tail: price the trade in USD and assign a unit tier.
 *
 * USD comes from the focus leg where possible (focus amount x focus price) —
 * which is what makes sizes comparable across pools with different counter
 * tokens. If the focus price is missing we try the counter leg. If both are
 * missing the swap keeps `usd: null` and renders as "unpriced"; we never
 * substitute a placeholder number.
 */
export function finalizeSwap(input: FinalizeInput): RealSwap {
  const { ctx } = input;

  let usd: number | null = null;
  if (input.usdOverride !== undefined && input.usdOverride !== null && input.usdOverride > 0) {
    usd = input.usdOverride;
  } else if (ctx.focusPriceUsd !== null && input.focusAmount > 0) {
    usd = input.focusAmount * ctx.focusPriceUsd;
  } else if (ctx.counterPriceUsd !== null && input.counterAmount > 0) {
    usd = input.counterAmount * ctx.counterPriceUsd;
  }

  return {
    id: `${input.txHash}-${input.logIndex}`,
    txHash: input.txHash,
    logIndex: input.logIndex,
    blockNumber: input.blockNumber,
    timestamp: input.timestamp,
    poolAddress: input.poolAddress,
    dexLabel: ctx.meta.dexLabel,
    side: input.side,
    focusAmount: input.focusAmount,
    counterAmount: input.counterAmount,
    usd,
    focusSymbol: ctx.focusSymbol,
    counterSymbol: ctx.counterSymbol,
    trader: input.trader,
    tier: tierForUsd(usd, ctx.scale),
    source: input.source,
    amm: input.amm,
  };
}
