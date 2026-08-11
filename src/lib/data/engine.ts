'use client';

/**
 * The data engine: everything the battlefield renders originates here.
 *
 * A battlefield is a *group* of real pools — by default every liquid pool
 * trading the focus token, across every PulseChain DEX at once. Their swaps are
 * merged into one fight, which is both much busier than a single pool and a
 * truer picture of the token's flow.
 *
 * Four live sources, each doing what it is genuinely best at:
 *
 *   RPC WebSocket  -> individual Swap events across all enlisted pools, pushed
 *                     within a block of mining. Also Sync events, which update
 *                     V2 reserves with zero polling.
 *   RPC eth_getLogs-> backfill, so the killfeed has real history on load.
 *   DexScreener    -> USD price, liquidity, volume — one request prices the
 *                     whole group.
 *   PulseX subgraph-> independent confirmation for the PulseX pools.
 *
 * If a source degrades the battlefield keeps running on the rest and the HUD
 * says so. Nothing is ever substituted with invented data.
 */

import { backfillSwaps, DEFAULT_BACKFILL_BLOCKS } from '../chain/logs';
import { SwapSocket, type SocketEvent } from '../chain/swapSocket';
import { browserRpc } from '../chain/transport';
import { decodeSyncLog, formatUnits } from '../chain/abi';
import {
  ABSOLUTE_SCALE,
  buildPoolContext,
  deriveAdaptiveScale,
  normalizeSwapLog,
  tierForUsd,
  type PoolContext,
  type TierScale,
} from './classify';
import { field, resetField, swapQueue } from '../sim/field';
import {
  refreshPressureWindow,
  targetKey,
  useBattleStore,
  type GroupTotals,
  type PoolSummary,
} from '@/store/battle';
import type { BattleGroup } from './group';
import type {
  BattleTarget,
  MarketSnapshot,
  RealSwap,
  Reserves,
  SourceId,
  SourceStatus,
} from './types';

const PRICE_POLL_MS = 2_500;
const SUBGRAPH_POLL_MS = 6_000;
const RESERVE_POLL_MS = 25_000;
const PRESSURE_TICK_MS = 3_000;

/**
 * Unit-count tuning.
 *
 * The armies are a squad, not a swarm: ~20 properly modelled soldiers a side
 * you can actually see, rather than hundreds of markers. Head count still
 * scales with real reserve value (square-root, so a 100x deeper pool doesn't
 * need 100x the troops), but it saturates quickly — the precise wall value is
 * reported in the HUD, where a number belongs.
 */
const UNITS_PER_SQRT_USD = 1 / 70;
const MAX_UNITS_PER_SIDE = 28;
const MAX_UNITS_PER_SIDE_LOW = 16;
const MIN_UNITS_PER_SIDE = 5;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function txnRatio(w: { buys: number; sells: number } | undefined): number | null {
  if (!w) return null;
  const total = w.buys + w.sells;
  return total > 0 ? (w.buys - w.sells) / total : null;
}

interface PoolRuntime {
  ctx: PoolContext;
  reserves: Reserves;
  market: MarketSnapshot | null;
  /** Which token this pool is scored on — per pool, because a war has many. */
  focusAddress: string;
  focusReserveUsd: number | null;
  counterReserveUsd: number | null;
}

export class BattleEngine {
  private socket: SwapSocket | null = null;
  private pools = new Map<string, PoolRuntime>();
  private focusAddress = '';
  private target: BattleTarget | null = null;
  private stopped = true;
  private generation = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private blockTimes = new Map<number, number>();
  private lastHeadTs = 0;
  /**
   * Rolling sample of observed swap sizes, newest last, used to derive the
   * adaptive unit-class cutoffs. Seeded by backfill so the ladder is calibrated
   * before the first live trade arrives.
   */
  private usdSamples: number[] = [];
  private scale: TierScale = { ...ABSOLUTE_SCALE, mode: 'adaptive' };
  /** Round-robin cursor over a war's tokens for price refreshes. */
  private warTokenCursor = 0;

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  async start(target: BattleTarget): Promise<void> {
    this.stop();
    this.stopped = false;
    const gen = ++this.generation;
    this.target = target;

    const store = useBattleStore.getState();
    resetField();
    store.setBoot('resolving');
    this.setSource('rpc', { state: 'connecting' });
    this.setSource('dexscreener', { state: 'connecting' });
    this.setSource('subgraph', { state: 'idle', detail: 'PulseX pools only' });

    const query = groupQuery(target);

    let group: BattleGroup;
    try {
      const res = await fetch(`/battlefield/api/group?${query}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to resolve battlefield (HTTP ${res.status})`);
      }
      group = (await res.json()) as BattleGroup;
    } catch (err) {
      if (gen !== this.generation) return;
      const message = err instanceof Error ? err.message : 'Failed to resolve battlefield';
      this.setSource('rpc', { state: 'error', error: message });
      useBattleStore.getState().setBoot('error', message);
      return;
    }
    if (gen !== this.generation || this.stopped) return;

    this.focusAddress = group.focus.address.toLowerCase();
    this.pools.clear();

    const summaries: PoolSummary[] = [];
    for (const p of group.pools) {
      const poolFocus = p.focusAddress.toLowerCase();
      const ctx = buildPoolContext(
        p.meta,
        poolFocus,
        focusPriceFor(p.market, poolFocus),
        counterPriceFor(p.market, poolFocus),
        this.scale,
      );
      this.pools.set(p.meta.address, {
        ctx,
        reserves: p.reserves,
        market: p.market,
        focusAddress: poolFocus,
        focusReserveUsd: p.focusReserveUsd,
        counterReserveUsd: p.counterReserveUsd,
      });
      summaries.push({
        address: p.meta.address,
        dexId: p.meta.dexId,
        dexLabel: p.meta.dexLabel,
        focusSymbol: p.focusSymbol,
        counterSymbol: ctx.counterSymbol,
        liquidityUsd: p.market?.liquidityUsd ?? null,
        volume24Usd: p.market?.volume.h24 ?? 0,
        txns24: p.market ? p.market.txns.h24.buys + p.market.txns.h24.sells : 0,
        focusReserveUsd: p.focusReserveUsd,
        counterReserveUsd: p.counterReserveUsd,
        reserveOrigin: p.reserves.origin,
        blockNumber: p.reserves.blockNumber,
        observedSwaps: 0,
      });
    }

    const s = useBattleStore.getState();
    s.setGroup(group.focus, summaries, group.totals);
    s.setChainHead(group.chainHead);
    s.setWarnings(group.warnings);

    this.setSource('rpc', {
      state: 'live',
      lastOkAt: Date.now(),
      error: null,
      detail: `${summaries.length} pool${summaries.length === 1 ? '' : 's'} · block ${group.chainHead.toLocaleString()}`,
    });
    this.setSource('dexscreener', {
      state: group.focus.priceUsd !== null ? 'live' : 'degraded',
      lastOkAt: group.focus.priceUsd !== null ? Date.now() : null,
      error: group.focus.priceUsd !== null ? null : 'no USD price available',
      detail: `${summaries.filter((p) => p.liquidityUsd !== null).length}/${summaries.length} priced`,
    });

    this.recomputeField();
    useBattleStore.getState().setBoot('ready');

    this.openSocket(gen);
    void this.runBackfill(gen);
    this.schedule(() => this.pollPrices(gen), PRICE_POLL_MS);
    this.schedule(() => this.pollSubgraph(gen), 1_500);
    this.schedule(() => this.pollReserves(gen), RESERVE_POLL_MS);
    this.schedule(() => this.tickPressure(gen), PRESSURE_TICK_MS);
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.socket?.stop();
    this.socket = null;
    this.pools.clear();
    this.blockTimes.clear();
    this.target = null;
  }

  private schedule(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers = this.timers.filter((x) => x !== t);
      if (!this.stopped) fn();
    }, ms);
    this.timers.push(t);
  }

  private setSource(id: SourceId, patch: Partial<SourceStatus>): void {
    useBattleStore.getState().setSource(id, patch);
  }

  private alive(gen: number): boolean {
    return !this.stopped && gen === this.generation;
  }

  private get poolAddresses(): string[] {
    return Array.from(this.pools.keys());
  }

  /* ---------------------------------------------------------------- */
  /* Live socket                                                       */
  /* ---------------------------------------------------------------- */

  private openSocket(gen: number): void {
    this.setSource('websocket', { state: 'connecting' });
    this.socket = new SwapSocket((event) => {
      if (!this.alive(gen)) return;
      this.handleSocketEvent(event);
    });
    this.socket.start(this.poolAddresses);
  }

  private handleSocketEvent(event: SocketEvent): void {
    switch (event.type) {
      case 'status':
        this.setSource('websocket', {
          state: event.state,
          detail: event.detail ?? null,
          error: event.error ?? null,
          ...(event.state === 'live' ? { lastOkAt: Date.now() } : {}),
        });
        return;

      case 'head': {
        this.blockTimes.set(event.blockNumber, event.timestamp);
        this.lastHeadTs = event.timestamp;
        if (this.blockTimes.size > 400) {
          const cutoff = event.blockNumber - 300;
          for (const b of this.blockTimes.keys()) if (b < cutoff) this.blockTimes.delete(b);
        }
        useBattleStore.getState().setChainHead(event.blockNumber);
        this.setSource('websocket', { state: 'live', lastOkAt: Date.now(), error: null });
        return;
      }

      case 'sync':
        this.applySyncEvent(event.log);
        return;

      case 'swap': {
        const pool = this.pools.get(event.log.address.toLowerCase());
        if (!pool) return;
        const blockNumber = Number.parseInt(event.log.blockNumber, 16);
        const timestamp =
          this.blockTimes.get(blockNumber) ?? this.lastHeadTs ?? Math.floor(Date.now() / 1000);
        const swap = normalizeSwapLog(event.log, pool.ctx, timestamp, 'websocket');
        if (swap) this.ingest([swap]);
        return;
      }
    }
  }

  /**
   * A `Sync` log carries a V2 pool's post-trade reserves, so army strength
   * tracks the chain exactly with no polling round-trip. V3-style pools emit no
   * Sync — those are refreshed by the slow reserve poll instead.
   */
  private applySyncEvent(log: { address: string; data: string; blockNumber: string }): void {
    const pool = this.pools.get(log.address.toLowerCase());
    if (!pool) return;
    const decoded = decodeSyncLog(log);
    if (!decoded) return;

    const { meta } = pool.ctx;
    pool.reserves = {
      reserve0Raw: decoded.reserve0.toString(),
      reserve1Raw: decoded.reserve1.toString(),
      amount0: formatUnits(decoded.reserve0, meta.token0.decimals),
      amount1: formatUnits(decoded.reserve1, meta.token1.decimals),
      blockNumber: Number.parseInt(log.blockNumber, 16) || 0,
      fetchedAt: Date.now(),
      origin: 'sync-event',
    };
    this.repriceReserves(pool);
    useBattleStore.getState().patchPool(meta.address, {
      focusReserveUsd: pool.focusReserveUsd,
      counterReserveUsd: pool.counterReserveUsd,
      reserveOrigin: 'sync-event',
      blockNumber: pool.reserves.blockNumber,
    });
    this.recomputeField();
  }

  /* ---------------------------------------------------------------- */
  /* Backfill                                                          */
  /* ---------------------------------------------------------------- */

  private async runBackfill(gen: number): Promise<void> {
    const addresses = this.poolAddresses;
    if (addresses.length === 0) return;

    try {
      const { logs, blockTimestamps, headBlock } = await backfillSwaps(browserRpc, addresses, {
        blocks: DEFAULT_BACKFILL_BLOCKS,
        maxLogs: 150,
      });
      if (!this.alive(gen)) return;

      for (const [block, ts] of blockTimestamps) this.blockTimes.set(block, ts);

      const nowSec = Math.floor(Date.now() / 1000);
      const swaps: RealSwap[] = [];
      for (const log of logs) {
        const pool = this.pools.get(log.address.toLowerCase());
        if (!pool) continue;
        const blockNumber = Number.parseInt(log.blockNumber, 16);
        const ts = blockTimestamps.get(blockNumber) ?? nowSec;
        const swap = normalizeSwapLog(log, pool.ctx, ts, 'rpc-backfill');
        if (swap) swaps.push(swap);
      }

      useBattleStore.getState().setChainHead(headBlock);
      this.setSource('rpc', {
        state: 'live',
        lastOkAt: Date.now(),
        error: null,
        detail: `${addresses.length} pools · ${swaps.length} backfilled`,
      });

      // Calibrate the unit-class ladder from this history *before* the swaps are
      // filed, then re-tier them, so backfilled trades and live ones are judged
      // on the same scale.
      this.sampleUsd(swaps.map((s) => s.usd).filter((u): u is number => u !== null && u > 0));
      this.recalibrateScale();
      this.rebuildContexts();
      for (const s of swaps) s.tier = tierForUsd(s.usd, this.scale);

      // Historical trades populate the feed and the stats, but are not fired at
      // the field — replaying hours of explosions on load would be theatre.
      this.ingest(swaps, { spawn: false });
    } catch (err) {
      if (!this.alive(gen)) return;
      this.setSource('rpc', {
        state: 'degraded',
        error: err instanceof Error ? err.message : 'backfill failed',
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Polling                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Refresh USD prices for every enlisted pool.
   *
   * For a token battlefield this is a single DexScreener call that covers all
   * pools at once, so an eight-pool field costs no more rate limit than one.
   */
  private async pollPrices(gen: number): Promise<void> {
    if (!this.alive(gen) || !this.target) return;

    if (typeof document !== 'undefined' && document.hidden) {
      this.schedule(() => this.pollPrices(gen), PRICE_POLL_MS * 4);
      return;
    }

    // A war spans several tokens and DexScreener has no call that returns every
    // pool for all of them at once, so tokens are refreshed round-robin — one
    // per tick. Six tokens at a 2.5s tick means each refreshes every 15s for
    // ~24 requests/min, comfortably inside the 60/min ceiling. Prices barely
    // move in 15s, and swap valuation always uses the latest known quote.
    let query: string;
    if (this.target.kind === 'war') {
      const tokens = this.target.tokens;
      const token = tokens[this.warTokenCursor % tokens.length];
      this.warTokenCursor++;
      query = `token=${token.address}`;
    } else if (this.target.kind === 'token') {
      query = `token=${this.target.address}`;
    } else {
      query = `pool=${this.target.address}`;
    }

    try {
      const res = await fetch(`/battlefield/api/prices?${query}`, { cache: 'no-store' });
      if (!this.alive(gen)) return;

      if (res.status === 429) {
        this.setSource('dexscreener', { state: 'degraded', error: 'rate limited — backing off' });
        this.schedule(() => this.pollPrices(gen), PRICE_POLL_MS * 4);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const body = (await res.json()) as { markets?: MarketSnapshot[] };
      if (!this.alive(gen)) return;

      const markets = body.markets ?? [];
      const byAddress = new Map(markets.map((m) => [m.pairAddress.toLowerCase(), m]));

      // Update whichever enlisted pools this response covered; the rest keep
      // their last known quote until their token's turn comes round.
      let refreshed = 0;
      for (const [address, pool] of this.pools) {
        const market = byAddress.get(address);
        if (!market) continue;
        pool.market = market;
        refreshed++;
      }

      // Re-derive every pool's context so newly arriving swaps are valued at the
      // price that is live right now.
      this.rebuildContexts();
      for (const [, pool] of this.pools) this.repriceReserves(pool);

      // Headline price/change across the theatre, liquidity-weighted. A war has
      // many tokens, so it reports no single price — only the aggregate move.
      let num = 0;
      let weight = 0;
      let changeNum = 0;
      let priced = 0;
      for (const [, pool] of this.pools) {
        const m = pool.market;
        if (!m) continue;
        priced++;
        const liq = m.liquidityUsd ?? 0;
        if (liq <= 0) continue;
        const fp = focusPriceFor(m, pool.focusAddress);
        if (fp !== null) num += fp * liq;
        changeNum += m.priceChange.h24 * liq;
        weight += liq;
      }
      const isWar = this.target?.kind === 'war';
      const focusPriceUsd = !isWar && weight > 0 ? num / weight : null;
      const change24 = weight > 0 ? changeNum / weight : null;

      const store = useBattleStore.getState();
      store.setFocusPrice(focusPriceUsd, change24);
      store.setGroupTotals(this.aggregateTotals());
      for (const [address, pool] of this.pools) {
        store.patchPool(address, {
          liquidityUsd: pool.market?.liquidityUsd ?? null,
          volume24Usd: pool.market?.volume.h24 ?? 0,
          txns24: pool.market ? pool.market.txns.h24.buys + pool.market.txns.h24.sells : 0,
          focusReserveUsd: pool.focusReserveUsd,
          counterReserveUsd: pool.counterReserveUsd,
        });
      }

      this.setSource('dexscreener', {
        state: priced > 0 ? 'live' : 'degraded',
        lastOkAt: priced > 0 ? Date.now() : null,
        error: priced > 0 ? null : 'no pools priced',
        detail: isWar
          ? `${priced}/${this.pools.size} priced · ${refreshed} refreshed`
          : `${priced}/${this.pools.size} priced`,
      });

      this.recomputeField();
    } catch (err) {
      if (!this.alive(gen)) return;
      this.setSource('dexscreener', {
        state: 'degraded',
        error: err instanceof Error ? err.message : 'poll failed',
      });
    }

    this.schedule(() => this.pollPrices(gen), PRICE_POLL_MS);
  }

  /**
   * Subgraph confirmation.
   *
   * Only PulseX pools are indexed by the PulseX subgraphs, so this checks the
   * deepest PulseX pool in the group and reports it as independent
   * corroboration of the on-chain reserves. Non-PulseX venues are simply not
   * covered, and the HUD says so rather than implying broader confirmation.
   */
  private async pollSubgraph(gen: number): Promise<void> {
    if (!this.alive(gen)) return;

    if (typeof document !== 'undefined' && document.hidden) {
      this.schedule(() => this.pollSubgraph(gen), SUBGRAPH_POLL_MS * 4);
      return;
    }

    const pulsexPool = Array.from(this.pools.values())
      .filter((p) => p.ctx.meta.dexId === 'pulsex')
      .sort((a, b) => (b.market?.liquidityUsd ?? 0) - (a.market?.liquidityUsd ?? 0))[0];

    if (!pulsexPool) {
      this.setSource('subgraph', {
        state: 'idle',
        detail: 'no PulseX pool in this group',
        error: null,
      });
      this.schedule(() => this.pollSubgraph(gen), SUBGRAPH_POLL_MS * 3);
      return;
    }

    try {
      const address = pulsexPool.ctx.meta.address;
      const res = await fetch(`/battlefield/api/subgraph?pair=${address}&swaps=0`, { cache: 'no-store' });
      if (!this.alive(gen)) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const body = (await res.json()) as {
        pair: { reserveUSD: number; volumeUSD: number; version: 'v1' | 'v2' } | null;
        version: 'v1' | 'v2' | null;
        head: { blockNumber: number } | null;
        error: string | null;
      };
      if (!this.alive(gen)) return;

      const chainHead = useBattleStore.getState().chainHead;
      const lag =
        body.head && chainHead > 0 ? Math.max(0, chainHead - body.head.blockNumber) : null;

      if (!body.pair) {
        this.setSource('subgraph', {
          state: 'degraded',
          error: body.error ?? 'pool not indexed',
        });
      } else {
        this.setSource('subgraph', {
          state: lag !== null && lag > 60 ? 'degraded' : 'live',
          lastOkAt: Date.now(),
          error: body.error,
          detail: `PulseX ${body.pair.version.toUpperCase()} · $${Math.round(body.pair.reserveUSD).toLocaleString()}${lag !== null ? ` · ${lag} blk lag` : ''}`,
        });
      }
    } catch (err) {
      if (!this.alive(gen)) return;
      this.setSource('subgraph', {
        state: 'degraded',
        error: err instanceof Error ? err.message : 'poll failed',
      });
    }

    this.schedule(() => this.pollSubgraph(gen), SUBGRAPH_POLL_MS);
  }

  /**
   * Reserve safety net.
   *
   * Sync events keep V2 pools current for free. V3-style pools (9mm, Liberty)
   * emit no Sync, so this poll is their only refresh — and it also covers quiet
   * pools and any period where the socket is down.
   */
  private async pollReserves(gen: number): Promise<void> {
    if (!this.alive(gen) || !this.target) return;

    const stale = Array.from(this.pools.values()).some(
      (p) => Date.now() - p.reserves.fetchedAt > RESERVE_POLL_MS,
    );

    if (stale) {
      const query = groupQuery(this.target);
      try {
        const res = await fetch(`/battlefield/api/group?${query}`, { cache: 'no-store' });
        if (res.ok && this.alive(gen)) {
          const group = (await res.json()) as BattleGroup;
          const store = useBattleStore.getState();
          for (const p of group.pools) {
            const pool = this.pools.get(p.meta.address);
            if (!pool) continue;
            pool.reserves = p.reserves;
            this.repriceReserves(pool);
            store.patchPool(p.meta.address, {
              focusReserveUsd: pool.focusReserveUsd,
              counterReserveUsd: pool.counterReserveUsd,
              reserveOrigin: p.reserves.origin,
              blockNumber: p.reserves.blockNumber,
            });
          }
          store.setChainHead(group.chainHead);
          this.setSource('rpc', {
            state: 'live',
            lastOkAt: Date.now(),
            error: null,
            detail: `${this.pools.size} pools · block ${group.chainHead.toLocaleString()}`,
          });
          this.recomputeField();
        }
      } catch {
        /* the socket is the primary path; a missed refresh is not fatal */
      }
    }

    this.schedule(() => this.pollReserves(gen), RESERVE_POLL_MS);
  }

  private tickPressure(gen: number): void {
    if (!this.alive(gen)) return;
    refreshPressureWindow();
    // Keep the unit-class ladder tracking the market as it moves.
    if (this.recalibrateScale()) {
      this.rebuildContexts();
    }
    this.recomputeField();
    this.schedule(() => this.tickPressure(gen), PRESSURE_TICK_MS);
  }

  /* ---------------------------------------------------------------- */
  /* Derivation                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Recalibrate the unit-class ladder from real observed trade sizes.
   *
   * Returns true when the cutoffs moved enough to warrant rebuilding pool
   * contexts (they carry the scale that classifies each incoming swap).
   */
  private recalibrateScale(): boolean {
    const mode = useBattleStore.getState().scaleMode;

    const next: TierScale =
      mode === 'absolute'
        ? { ...ABSOLUTE_SCALE, samples: this.usdSamples.length }
        : deriveAdaptiveScale([...this.usdSamples].sort((a, b) => a - b));

    const moved =
      next.mode !== this.scale.mode ||
      Math.abs(next.tank - this.scale.tank) / Math.max(1, this.scale.tank) > 0.02 ||
      Math.abs(next.artillery - this.scale.artillery) / Math.max(1, this.scale.artillery) > 0.02 ||
      Math.abs(next.nuke - this.scale.nuke) / Math.max(1, this.scale.nuke) > 0.02;

    this.scale = next;
    useBattleStore.getState().setTierScale(next);
    return moved;
  }

  /** Record a priced swap into the rolling distribution sample. */
  private sampleUsd(values: number[]): void {
    if (values.length === 0) return;
    this.usdSamples.push(...values);
    // Bounded, newest-wins: the ladder should track the market as it is now,
    // not as it was an hour ago.
    const MAX_SAMPLES = 900;
    if (this.usdSamples.length > MAX_SAMPLES) {
      this.usdSamples = this.usdSamples.slice(this.usdSamples.length - MAX_SAMPLES);
    }
  }

  /**
   * Rebuild every pool context so later swaps use the current prices and scale.
   * Each pool prices itself against its own focus token, which is what makes a
   * multi-token war work at all.
   */
  private rebuildContexts(): void {
    for (const [, pool] of this.pools) {
      pool.ctx = buildPoolContext(
        pool.ctx.meta,
        pool.focusAddress,
        focusPriceFor(pool.market, pool.focusAddress),
        counterPriceFor(pool.market, pool.focusAddress),
        this.scale,
      );
    }
  }

  /** Recompute a pool's two reserve legs in USD from its current prices. */
  private repriceReserves(pool: PoolRuntime): void {
    const { ctx, reserves } = pool;
    const focusAmount = ctx.focusIsToken0 ? reserves.amount0 : reserves.amount1;
    const counterAmount = ctx.focusIsToken0 ? reserves.amount1 : reserves.amount0;
    pool.focusReserveUsd = ctx.focusPriceUsd !== null ? focusAmount * ctx.focusPriceUsd : null;
    pool.counterReserveUsd =
      ctx.counterPriceUsd !== null ? counterAmount * ctx.counterPriceUsd : null;
  }

  private aggregateTotals(): GroupTotals {
    const totals: GroupTotals = {
      liquidityUsd: 0,
      volume24Usd: 0,
      volume5mUsd: 0,
      txns24: { buys: 0, sells: 0 },
      txns5m: { buys: 0, sells: 0 },
    };
    for (const pool of this.pools.values()) {
      const m = pool.market;
      if (!m) continue;
      totals.liquidityUsd += m.liquidityUsd ?? 0;
      totals.volume24Usd += m.volume.h24;
      totals.volume5mUsd += m.volume.m5;
      totals.txns24.buys += m.txns.h24.buys;
      totals.txns24.sells += m.txns.h24.sells;
      totals.txns5m.buys += m.txns.m5.buys;
      totals.txns5m.sells += m.txns.m5.sells;
    }
    return totals;
  }

  /**
   * Push real swaps into the store and (for live ones) onto the field.
   *
   * `spawn: false` is used for history — backfill and subgraph catch-up — which
   * belongs in the feed and the statistics but must not detonate on screen.
   */
  private ingest(swaps: RealSwap[], opts: { spawn?: boolean } = {}): void {
    if (swaps.length === 0) return;
    const spawn = opts.spawn !== false;

    const fresh = useBattleStore.getState().ingestSwaps(swaps);
    if (fresh.length === 0) return;

    this.sampleUsd(fresh.map((s) => s.usd).filter((u): u is number => u !== null && u > 0));

    if (spawn) {
      const before = swapQueue.dropped;
      for (const s of fresh) swapQueue.push(s);
      const dropped = swapQueue.dropped - before;
      if (dropped > 0) useBattleStore.getState().noteDropped(dropped);

      // Large trades physically shove the front line, scaled by real price
      // impact: notional against the pool group's combined liquidity.
      const liquidity = useBattleStore.getState().groupTotals?.liquidityUsd ?? 0;
      if (liquidity > 0) {
        for (const s of fresh) {
          if (s.usd === null) continue;
          const impact = clamp((s.usd / liquidity) * 6, 0, 0.3);
          field.impulse += s.side === 'buy' ? impact : -impact;
          if (s.tier === 'nuke') {
            field.shake = Math.min(1.5, field.shake + Math.min(1, s.usd / 50_000));
          }
        }
      }
    }

    this.recomputeField();
  }

  /**
   * Translate market state into battlefield state.
   *
   * Front line  = real price momentum blended with real order flow.
   * Army sizes  = on-chain reserves across every enlisted pool, priced in USD.
   */
  private recomputeField(): void {
    const store = useBattleStore.getState();
    const { focus, groupTotals, pressure } = store;

    /* ---- front line ---- */
    let momentum = 0;
    if (focus?.priceChange24 !== null && focus?.priceChange24 !== undefined) {
      // 24h change is the only window available for a whole group; scale it so a
      // ±12% day is decisive.
      momentum = Math.tanh(focus.priceChange24 / 12);
    }

    const observedFlow = pressure.ratio;
    const aggregatorFlow = groupTotals
      ? (txnRatio(groupTotals.txns5m) ?? txnRatio(groupTotals.txns24))
      : null;
    const flow =
      observedFlow !== null && aggregatorFlow !== null
        ? 0.6 * observedFlow + 0.4 * aggregatorFlow
        : (observedFlow ?? aggregatorFlow ?? 0);

    const frontLine = clamp(0.4 * momentum + 0.6 * flow, -1, 1);
    field.frontLineTarget = frontLine;
    if (Math.abs(frontLine - store.frontLine) > 0.002) store.setFrontLine(frontLine);

    /* ---- army strength, summed across every enlisted pool ---- */
    let focusUsd = 0;
    let counterUsd = 0;
    let anyPriced = false;

    for (const pool of this.pools.values()) {
      if (pool.focusReserveUsd !== null) {
        focusUsd += pool.focusReserveUsd;
        anyPriced = true;
      }
      if (pool.counterReserveUsd !== null) {
        counterUsd += pool.counterReserveUsd;
        anyPriced = true;
      }
    }

    if (!anyPriced && groupTotals && groupTotals.liquidityUsd > 0) {
      // Last resort: split reported liquidity evenly. Flagged in the HUD by the
      // absence of per-pool reserve figures.
      focusUsd = groupTotals.liquidityUsd / 2;
      counterUsd = groupTotals.liquidityUsd / 2;
      anyPriced = true;
    }

    if (anyPriced) {
      const cap = field.lowPower ? MAX_UNITS_PER_SIDE_LOW : MAX_UNITS_PER_SIDE;
      const toUnits = (usd: number) =>
        Math.round(
          clamp(Math.sqrt(Math.max(0, usd)) * UNITS_PER_SQRT_USD, MIN_UNITS_PER_SIDE, cap),
        );

      // Green holds the buy wall: the counter-token reserves are the capital
      // that can be spent acquiring the focus token. Red holds the sell wall:
      // the focus-token reserves are the inventory that can be sold into it.
      field.greenStrengthUsd = counterUsd;
      field.redStrengthUsd = focusUsd;
      field.greenUnits = toUnits(counterUsd);
      field.redUnits = toUnits(focusUsd);
      field.hasData = true;
    }

    /* ---- heavy weapons dug in behind each line ---- */
    // One emplacement per tank-or-larger trade seen for that side in the
    // pressure window, so a side taking big money visibly masses artillery.
    const cutoff = Math.floor(Date.now() / 1000) - store.pressure.windowSec;
    let greenHeavy = 0;
    let redHeavy = 0;
    for (const s of store.feed) {
      if (s.timestamp < cutoff || s.tier === 'infantry') continue;
      if (s.side === 'buy') greenHeavy++;
      else redHeavy++;
    }
    field.greenHeavy = Math.min(6, greenHeavy);
    field.redHeavy = Math.min(6, redHeavy);

    field.intense = store.intense;
    field.lowPower = store.lowPower;
  }
}

/** Build the /api/group query string for any battlefield target. */
function groupQuery(target: BattleTarget): string {
  switch (target.kind) {
    case 'war':
      return `war=${encodeURIComponent(target.id)}`;
    case 'token':
      return `token=${target.address}&symbol=${encodeURIComponent(target.symbol)}`;
    case 'pool':
      return `pool=${target.address}&label=${encodeURIComponent(target.label)}`;
  }
}

/** USD price of the focus token as quoted by one pool. */
function focusPriceFor(market: MarketSnapshot | null, focusAddress: string): number | null {
  if (!market || market.priceUsd === null) return null;
  const baseIsFocus = market.baseToken.address.toLowerCase() === focusAddress;
  if (baseIsFocus) return market.priceUsd;
  return market.priceNative !== null && market.priceNative > 0
    ? market.priceUsd / market.priceNative
    : null;
}

/** USD price of the pool's other token. */
function counterPriceFor(market: MarketSnapshot | null, focusAddress: string): number | null {
  if (!market || market.priceUsd === null) return null;
  const baseIsFocus = market.baseToken.address.toLowerCase() === focusAddress;
  if (!baseIsFocus) return market.priceUsd;
  return market.priceNative !== null && market.priceNative > 0
    ? market.priceUsd / market.priceNative
    : null;
}

export const battleEngine = new BattleEngine();
export { targetKey };
