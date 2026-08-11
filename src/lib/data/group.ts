/**
 * Battle group resolution — assembling a battlefield out of real pools.
 *
 * A "token" battlefield enlists every liquid pool that trades the chosen token,
 * across every PulseChain DEX at once (PulseX V1/V2, 9mm, 9inch, Liberty,
 * SwitchX, …). All of their swaps land on the same field, which is both far
 * busier than any single pool and a truer picture of what the token is doing.
 *
 * A "pool" battlefield is the same machinery with one pool enlisted, which is
 * what you want when a specific venue is the subject.
 *
 * Pools are ranked by *observed trade count*, not liquidity — a deep but idle
 * pool contributes nothing to watch.
 */

import { fetchPoolMeta, fetchPoolReserves, PoolNotFoundError } from '../chain/pool';
import { fetchBlockNumber } from '../chain/pool';
import { fetchPairSnapshot, fetchTokenPairs } from './dexscreener';
import type {
  BattleTarget,
  MarketSnapshot,
  PoolEnlistment,
  PoolMeta,
  Reserves,
} from './types';

/**
 * Cap on enlisted pools.
 *
 * More pools means a busier, less static battlefield — the whole point of
 * fighting over a token rather than a single venue. The ceiling is set by what
 * one WebSocket subscription and one `eth_getLogs` range comfortably carry,
 * not by anything about the data.
 */
export const MAX_POOLS = 14;
/** A combined war spans several tokens, so it gets a bigger roster. */
export const MAX_WAR_POOLS = 26;
/** Below this, a pool's swaps are dust and its reserves distort nothing useful. */
const MIN_POOL_LIQUIDITY_USD = 1_500;
/** Per-token slice of a war roster, so one busy coin can't crowd out the rest. */
const MAX_POOLS_PER_WAR_TOKEN = 6;
/**
 * Most pools any single DEX may claim.
 *
 * PulseX carries the large majority of PulseChain volume, so a pure
 * activity ranking fills every slot with PulseX pools and the other venues
 * never appear. Reserving slots costs a little raw trade count and buys a
 * battlefield that reflects where the token actually trades — and it is how
 * 9mm, 9inch, Liberty and SwitchX get onto the field at all.
 */
const MAX_POOLS_PER_DEX = 6;

export interface BattleGroup {
  target: BattleTarget;
  focus: {
    address: string;
    symbol: string;
    /** Liquidity-weighted USD price across enlisted pools. Null if unpriceable. */
    priceUsd: number | null;
    /** Aggregate 24h price change, taken from the deepest pool that reports one. */
    priceChange24: number | null;
  };
  pools: PoolEnlistment[];
  totals: {
    liquidityUsd: number;
    volume24Usd: number;
    volume5mUsd: number;
    txns24: { buys: number; sells: number };
    txns5m: { buys: number; sells: number };
  };
  chainHead: number;
  warnings: string[];
}

/** Per-pool USD prices for the focus token and its counter token. */
function poolPrices(
  market: MarketSnapshot | null,
  focusAddress: string,
): { focus: number | null; counter: number | null } {
  if (!market || market.priceUsd === null) return { focus: null, counter: null };

  const focus = focusAddress.toLowerCase();
  const baseIsFocus = market.baseToken.address.toLowerCase() === focus;

  // DexScreener quotes the base token: priceUsd in dollars, priceNative in
  // units of the quote token. The quote token's dollar price follows.
  const quotePriceUsd =
    market.priceNative !== null && market.priceNative > 0
      ? market.priceUsd / market.priceNative
      : null;

  return baseIsFocus
    ? { focus: market.priceUsd, counter: quotePriceUsd }
    : { focus: quotePriceUsd, counter: market.priceUsd };
}

/** Rank candidate pools: activity first, depth as the tiebreak. */
function rankPools(a: MarketSnapshot, b: MarketSnapshot): number {
  const tx = (m: MarketSnapshot) => m.txns.h24.buys + m.txns.h24.sells;
  const byTx = tx(b) - tx(a);
  if (byTx !== 0) return byTx;
  return (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0);
}

async function enlist(
  market: MarketSnapshot | null,
  poolAddress: string,
  focusAddress: string,
  warnings: string[],
  focusSymbolHint?: string,
): Promise<PoolEnlistment | null> {
  let meta: PoolMeta;
  let reserves: Reserves;
  try {
    meta = await fetchPoolMeta(poolAddress, {
      dexId: market?.dexId,
      labels: market?.labels,
    });
    reserves = await fetchPoolReserves(meta);
  } catch (err) {
    warnings.push(
      `${poolAddress.slice(0, 10)}…: ${err instanceof Error ? err.message : 'unreadable pool'}`,
    );
    return null;
  }

  const focus = focusAddress.toLowerCase();
  if (
    meta.token0.address.toLowerCase() !== focus &&
    meta.token1.address.toLowerCase() !== focus
  ) {
    warnings.push(`${meta.dexLabel} pool ${poolAddress.slice(0, 10)}… does not hold the focus token`);
    return null;
  }

  const focusIsToken0 = meta.token0.address.toLowerCase() === focus;
  const focusAmount = focusIsToken0 ? reserves.amount0 : reserves.amount1;
  const counterAmount = focusIsToken0 ? reserves.amount1 : reserves.amount0;

  const prices = poolPrices(market, focus);

  return {
    meta,
    reserves,
    market,
    focusAddress: focus,
    focusSymbol:
      focusSymbolHint ?? (focusIsToken0 ? meta.token0.symbol : meta.token1.symbol),
    focusIsToken0,
    focusReserveUsd: prices.focus !== null ? focusAmount * prices.focus : null,
    counterReserveUsd: prices.counter !== null ? counterAmount * prices.counter : null,
  };
}

/**
 * Pick the roster for a combined war.
 *
 * Each token contributes its most *active* pools, capped per token so a single
 * busy coin cannot swamp the theatre. A pool that holds two of the war's tokens
 * is claimed by whichever appears first in the war's token list — that decides
 * which token the trade is scored on, and therefore which side it fights for.
 */
async function pickWarPools(
  tokens: { address: string; symbol: string }[],
  warnings: string[],
): Promise<{ address: string; market: MarketSnapshot | null; focus: string; symbol: string }[]> {
  const claimed = new Map<string, { address: string; market: MarketSnapshot | null; focus: string; symbol: string }>();

  const perToken = await Promise.all(
    tokens.map(async (t) => {
      try {
        return { token: t, markets: await fetchTokenPairs(t.address) };
      } catch (err) {
        warnings.push(
          `${t.symbol}: ${err instanceof Error ? err.message : 'DexScreener lookup failed'}`,
        );
        return { token: t, markets: [] as MarketSnapshot[] };
      }
    }),
  );

  // Tokens are processed in priority order, so the first claimant of a shared
  // pool wins it.
  for (const { token, markets } of perToken) {
    const eligible = markets
      .filter((m) => (m.liquidityUsd ?? 0) >= MIN_POOL_LIQUIDITY_USD)
      .filter((m) => m.txns.h24.buys + m.txns.h24.sells > 0)
      .sort(rankPools);

    let taken = 0;
    for (const m of eligible) {
      if (taken >= MAX_POOLS_PER_WAR_TOKEN) break;
      const addr = m.pairAddress.toLowerCase();
      if (claimed.has(addr)) continue;
      claimed.set(addr, {
        address: addr,
        market: m,
        focus: token.address.toLowerCase(),
        symbol: token.symbol,
      });
      taken++;
    }
    if (taken === 0) warnings.push(`${token.symbol}: no eligible pool`);
  }

  // Finally rank the whole theatre by activity and take the busiest.
  return Array.from(claimed.values())
    .sort((a, b) => {
      const tx = (m: MarketSnapshot | null) => (m ? m.txns.h24.buys + m.txns.h24.sells : 0);
      return tx(b.market) - tx(a.market);
    })
    .slice(0, MAX_WAR_POOLS);
}

/**
 * Resolve a battlefield.
 *
 * The on-chain reads are authoritative and must succeed for at least one pool;
 * DexScreener supplies USD pricing and is what lets us rank by activity. If
 * DexScreener is unavailable for a pool we still enlist it — its swaps are
 * real and will render, they just arrive unpriced until a quote lands.
 */
export async function resolveBattleGroup(target: BattleTarget): Promise<BattleGroup> {
  const warnings: string[] = [];

  /* ---- 1. Find candidate pools + establish the focus token ---------- */
  let candidates: { address: string; market: MarketSnapshot | null; focus: string; symbol: string }[] = [];
  let focusAddress: string;
  let focusSymbol: string;

  if (target.kind === 'war') {
    const picked = await pickWarPools(target.tokens, warnings);
    if (picked.length === 0) {
      throw new Error(`No eligible PulseChain pool found for any token in ${target.label}`);
    }
    candidates = picked;
    // A war has no single focus token; the deepest pool's token names the
    // theatre for display purposes only.
    focusAddress = picked[0].focus;
    focusSymbol = target.label;
  } else if (target.kind === 'token') {
    focusAddress = target.address.toLowerCase();
    focusSymbol = target.symbol;

    let markets: MarketSnapshot[] = [];
    try {
      markets = await fetchTokenPairs(focusAddress);
    } catch (err) {
      warnings.push(
        `DexScreener: ${err instanceof Error ? err.message : 'token lookup failed'}`,
      );
    }

    const ranked = markets
      .filter((m) => (m.liquidityUsd ?? 0) >= MIN_POOL_LIQUIDITY_USD)
      .filter((m) => m.txns.h24.buys + m.txns.h24.sells > 0)
      .sort(rankPools);

    // Two passes: first the best pools within each DEX's quota, then fill any
    // remaining slots with the next most active pools regardless of venue, so
    // a diversity rule never leaves the field emptier than it needs to be.
    const perDex = new Map<string, number>();
    const eligible: MarketSnapshot[] = [];
    for (const m of ranked) {
      if (eligible.length >= MAX_POOLS) break;
      const used = perDex.get(m.dexId) ?? 0;
      if (used >= MAX_POOLS_PER_DEX) continue;
      perDex.set(m.dexId, used + 1);
      eligible.push(m);
    }
    if (eligible.length < MAX_POOLS) {
      for (const m of ranked) {
        if (eligible.length >= MAX_POOLS) break;
        if (eligible.includes(m)) continue;
        eligible.push(m);
      }
    }

    if (eligible.length === 0) {
      throw new Error(
        `No PulseChain pool for ${target.symbol} clears $${MIN_POOL_LIQUIDITY_USD.toLocaleString()} liquidity with trades in the last 24h`,
      );
    }

    candidates = eligible.map((m) => ({
      address: m.pairAddress,
      market: m,
      focus: focusAddress,
      symbol: focusSymbol,
    }));
  } else {
    // Single pool: DexScreener's base token is the natural focus; if it doesn't
    // index the pool we fall back to the contract's own token0.
    const market = await fetchPairSnapshot(target.address).catch(() => null);
    if (!market) {
      warnings.push('DexScreener does not index this pool — swaps will render unpriced');
      const meta = await fetchPoolMeta(target.address);
      focusAddress = meta.token0.address;
      focusSymbol = meta.token0.symbol;
    } else {
      focusAddress = market.baseToken.address;
      focusSymbol = market.baseToken.symbol;
    }
    candidates = [
      {
        address: target.address.toLowerCase(),
        market,
        focus: focusAddress,
        symbol: focusSymbol,
      },
    ];
  }

  /* ---- 2. Read every pool from chain, in parallel ------------------- */
  const settled = await Promise.all(
    candidates.map((c) => enlist(c.market, c.address, c.focus, warnings, c.symbol)),
  );
  const pools = settled.filter((p): p is PoolEnlistment => p !== null);

  if (pools.length === 0) {
    throw new PoolNotFoundError(candidates[0]?.address ?? focusAddress);
  }

  /* ---- 3. Aggregate ------------------------------------------------- */
  // Liquidity-weighted focus price: the deepest pools dominate the quote, which
  // is what you want when a thin pool is briefly off-market.
  //
  // A war spans several tokens, so a single "price" would be meaningless — it
  // reports null, and the HUD shows the theatre's aggregate figures instead.
  let focusPriceUsd: number | null = null;
  if (target.kind !== 'war') {
    let priceNumerator = 0;
    let priceWeight = 0;
    for (const p of pools) {
      const prices = poolPrices(p.market, p.focusAddress);
      const weight = p.market?.liquidityUsd ?? 0;
      if (prices.focus !== null && weight > 0) {
        priceNumerator += prices.focus * weight;
        priceWeight += weight;
      }
    }
    focusPriceUsd = priceWeight > 0 ? priceNumerator / priceWeight : null;
  }

  // Liquidity-weighted 24h move across the theatre — for a single token this is
  // effectively the deepest pool's number; for a war it's the ecosystem's.
  let changeNum = 0;
  let changeWeight = 0;
  for (const p of pools) {
    const w = p.market?.liquidityUsd ?? 0;
    if (p.market && w > 0) {
      changeNum += p.market.priceChange.h24 * w;
      changeWeight += w;
    }
  }
  const priceChange24 = changeWeight > 0 ? changeNum / changeWeight : null;

  const totals = {
    liquidityUsd: 0,
    volume24Usd: 0,
    volume5mUsd: 0,
    txns24: { buys: 0, sells: 0 },
    txns5m: { buys: 0, sells: 0 },
  };
  for (const p of pools) {
    if (!p.market) continue;
    totals.liquidityUsd += p.market.liquidityUsd ?? 0;
    totals.volume24Usd += p.market.volume.h24;
    totals.volume5mUsd += p.market.volume.m5;
    totals.txns24.buys += p.market.txns.h24.buys;
    totals.txns24.sells += p.market.txns.h24.sells;
    totals.txns5m.buys += p.market.txns.m5.buys;
    totals.txns5m.sells += p.market.txns.m5.sells;
  }

  const chainHead = pools.reduce((m, p) => Math.max(m, p.reserves.blockNumber), 0);

  return {
    target,
    focus: {
      address: focusAddress,
      symbol: focusSymbol,
      priceUsd: focusPriceUsd,
      priceChange24,
    },
    pools,
    totals,
    chainHead: chainHead || (await fetchBlockNumber().catch(() => 0)),
    warnings,
  };
}
