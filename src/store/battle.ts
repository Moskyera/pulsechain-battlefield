'use client';

/**
 * UI-facing state.
 *
 * Deliberately *not* where per-frame combat lives — that goes through
 * `lib/sim/field`. This store holds what a person reads: which battlefield is
 * loaded, which pools are enlisted, the health of each data source, the
 * killfeed, and the running totals.
 */

import { create } from 'zustand';
import { WAR_PRESETS } from '@/lib/chain/constants';
import { ABSOLUTE_SCALE, type TierScale } from '@/lib/data/classify';
import type {
  BattleTarget,
  PressureWindow,
  RealSwap,
  Reserves,
  SourceId,
  SourceStatus,
  WarToken,
} from '@/lib/data/types';

/** How many swaps we retain for statistics. The killfeed renders a slice of this. */
const FEED_CAPACITY = 260;
/** Rolling window used for the force bar. */
export const PRESSURE_WINDOW_SEC = 300;

export type BootState = 'idle' | 'resolving' | 'ready' | 'error';

/**
 * How much image treatment to run.
 *
 * These are per-pixel costs, and they scale with the square of the window, so
 * what is free on one machine is punishing on another with a bigger screen.
 *
 *   full  everything, including ambient occlusion. AO is the expensive one:
 *         it renders the entire scene a second time into a normal buffer
 *         before it can even start shading.
 *   lite  bloom, grade, vignette and antialiasing. No second scene pass.
 *   off   no chain at all, and the renderer does its own tone mapping.
 *
 * Default is off. The chain is genuinely expensive on a large screen and the
 * scene stands up without it, so it is something you switch on when you want
 * the picture rather than something you have to find and switch off.
 */
export type FxLevel = 'full' | 'lite' | 'off';

/** One enlisted pool, flattened for display. */
export interface PoolSummary {
  address: string;
  dexId: string;
  dexLabel: string;
  /** Which war token this pool is scored on. */
  focusSymbol: string;
  counterSymbol: string;
  liquidityUsd: number | null;
  volume24Usd: number;
  txns24: number;
  focusReserveUsd: number | null;
  counterReserveUsd: number | null;
  reserveOrigin: Reserves['origin'];
  blockNumber: number;
  /** Swaps this session attributed to this pool — shows who is actually busy. */
  observedSwaps: number;
}

export interface FocusInfo {
  address: string;
  symbol: string;
  priceUsd: number | null;
  priceChange24: number | null;
}

export interface GroupTotals {
  liquidityUsd: number;
  volume24Usd: number;
  volume5mUsd: number;
  txns24: { buys: number; sells: number };
  txns5m: { buys: number; sells: number };
}

export interface SessionTotals {
  buyUsd: number;
  sellUsd: number;
  buyCount: number;
  sellCount: number;
  unpricedCount: number;
  biggest: RealSwap | null;
  startedAt: number;
}

const emptyStatus = (): SourceStatus => ({
  state: 'idle',
  lastOkAt: null,
  error: null,
  detail: null,
});

const emptyPressure = (): PressureWindow => ({
  windowSec: PRESSURE_WINDOW_SEC,
  buyUsd: 0,
  sellUsd: 0,
  buyCount: 0,
  sellCount: 0,
  ratio: null,
});

const emptyTotals = (): SessionTotals => ({
  buyUsd: 0,
  sellUsd: 0,
  buyCount: 0,
  sellCount: 0,
  unpricedCount: 0,
  biggest: null,
  startedAt: Date.now(),
});

/** Open on the combined war — it is by far the busiest, least static field. */
const DEFAULT_TARGET: BattleTarget = {
  kind: 'war',
  id: WAR_PRESETS[0].id,
  label: WAR_PRESETS[0].label,
  tokens: WAR_PRESETS[0].tokens.map((t) => ({
    address: t.address.toLowerCase(),
    symbol: t.symbol,
  })),
};

export interface BattleStore {
  /* ---- selection ---- */
  target: BattleTarget;

  /* ---- resolved battlefield ---- */
  focus: FocusInfo | null;
  pools: PoolSummary[];
  groupTotals: GroupTotals | null;
  chainHead: number;

  /* ---- status ---- */
  sources: Record<SourceId, SourceStatus>;
  boot: BootState;
  bootError: string | null;
  warnings: string[];

  /* ---- live combat readouts ---- */
  feed: RealSwap[];
  pressure: PressureWindow;
  totals: SessionTotals;
  frontLine: number;
  droppedForRender: number;

  /* ---- settings ---- */
  intense: boolean;
  soundEnabled: boolean;
  lowPower: boolean;
  /** Image treatment level. Forced to 'off' by the light scene. */
  fx: FxLevel;
  /** What the renderer is actually doing, so slowness can be reported in numbers. */
  renderStats: { fps: number; width: number; height: number; dpr: number };
  showHud: boolean;
  /** Market feed (the transaction list) can be hidden on its own. */
  showFeed: boolean;
  /** Left-hand intel + enlisted-pool columns can be hidden on their own. */
  showPanels: boolean;
  /**
   * Which unit-class ladder is in force, and its live cutoffs.
   * Adaptive by default — see the note on TierScale for the measurements
   * behind that choice.
   */
  scaleMode: 'absolute' | 'adaptive';
  tierScale: TierScale;

  /* ---- actions ---- */
  selectWar: (id: string, label: string, tokens: WarToken[]) => void;
  selectToken: (address: string, symbol: string) => void;
  selectPool: (address: string, label: string) => void;
  setBoot: (state: BootState, error?: string | null) => void;
  setWarnings: (warnings: string[]) => void;
  setSource: (id: SourceId, patch: Partial<SourceStatus>) => void;
  setGroup: (focus: FocusInfo, pools: PoolSummary[], totals: GroupTotals) => void;
  patchPool: (address: string, patch: Partial<PoolSummary>) => void;
  setFocusPrice: (priceUsd: number | null, priceChange24: number | null) => void;
  setGroupTotals: (totals: GroupTotals) => void;
  setChainHead: (block: number) => void;
  setFrontLine: (value: number) => void;
  ingestSwaps: (swaps: RealSwap[]) => RealSwap[];
  noteDropped: (count: number) => void;
  toggleIntense: () => void;
  toggleSound: () => void;
  toggleHud: () => void;
  toggleFeed: () => void;
  togglePanels: () => void;
  toggleScaleMode: () => void;
  setTierScale: (scale: TierScale) => void;
  setLowPower: (value: boolean) => void;
  cycleFx: () => void;
  setRenderStats: (stats: { fps: number; width: number; height: number; dpr: number }) => void;
}

/**
 * Recompute the rolling buy/sell window from real swaps.
 *
 * Unpriced swaps (no USD available yet) are counted but contribute no notional,
 * so they can never distort the ratio.
 */
function computePressure(feed: RealSwap[], nowSec: number): PressureWindow {
  let buyUsd = 0;
  let sellUsd = 0;
  let buyCount = 0;
  let sellCount = 0;

  for (const s of feed) {
    if (nowSec - s.timestamp > PRESSURE_WINDOW_SEC) continue;
    if (s.side === 'buy') {
      buyCount++;
      buyUsd += s.usd ?? 0;
    } else {
      sellCount++;
      sellUsd += s.usd ?? 0;
    }
  }

  const total = buyUsd + sellUsd;
  const ratio =
    total > 0
      ? (buyUsd - sellUsd) / total
      : buyCount + sellCount > 0
        ? (buyCount - sellCount) / (buyCount + sellCount)
        : null;

  return { windowSec: PRESSURE_WINDOW_SEC, buyUsd, sellUsd, buyCount, sellCount, ratio };
}

/** Ids already ingested, so backfill + websocket + subgraph never double-count. */
let seenIds = new Set<string>();

function freshBattleState() {
  seenIds = new Set();
  return {
    focus: null,
    pools: [],
    groupTotals: null,
    feed: [],
    pressure: emptyPressure(),
    totals: emptyTotals(),
    frontLine: 0,
    droppedForRender: 0,
    boot: 'resolving' as BootState,
    bootError: null,
    warnings: [],
  };
}

export const useBattleStore = create<BattleStore>((set, get) => ({
  target: DEFAULT_TARGET,

  focus: null,
  pools: [],
  groupTotals: null,
  chainHead: 0,

  sources: {
    dexscreener: emptyStatus(),
    rpc: emptyStatus(),
    websocket: emptyStatus(),
    subgraph: emptyStatus(),
  },
  boot: 'idle',
  bootError: null,
  warnings: [],

  feed: [],
  pressure: emptyPressure(),
  totals: emptyTotals(),
  frontLine: 0,
  droppedForRender: 0,

  intense: false,
  soundEnabled: false,
  lowPower: false,
  fx: 'off',
  renderStats: { fps: 0, width: 0, height: 0, dpr: 1 },
  showHud: true,
  showFeed: true,
  showPanels: true,
  scaleMode: 'adaptive',
  tierScale: { ...ABSOLUTE_SCALE, mode: 'adaptive' },

  selectWar: (id, label, tokens) => {
    const t = get().target;
    if (t.kind === 'war' && t.id === id) return;
    set({ target: { kind: 'war', id, label, tokens }, ...freshBattleState() });
  },

  selectToken: (address, symbol) => {
    const addr = address.toLowerCase();
    const t = get().target;
    if (t.kind === 'token' && t.address === addr) return;
    set({ target: { kind: 'token', address: addr, symbol }, ...freshBattleState() });
  },

  selectPool: (address, label) => {
    const addr = address.toLowerCase();
    const t = get().target;
    if (t.kind === 'pool' && t.address === addr) return;
    set({ target: { kind: 'pool', address: addr, label }, ...freshBattleState() });
  },

  setBoot: (state, error = null) => set({ boot: state, bootError: error }),
  setWarnings: (warnings) => set({ warnings }),

  setSource: (id, patch) =>
    set((s) => ({ sources: { ...s.sources, [id]: { ...s.sources[id], ...patch } } })),

  setGroup: (focus, pools, groupTotals) => set({ focus, pools, groupTotals }),

  patchPool: (address, patch) =>
    set((s) => {
      const addr = address.toLowerCase();
      let changed = false;
      const pools = s.pools.map((p) => {
        if (p.address !== addr) return p;
        changed = true;
        return { ...p, ...patch };
      });
      return changed ? { pools } : s;
    }),

  setFocusPrice: (priceUsd, priceChange24) =>
    set((s) => (s.focus ? { focus: { ...s.focus, priceUsd, priceChange24 } } : s)),

  setGroupTotals: (groupTotals) => set({ groupTotals }),

  setChainHead: (block) => set((s) => (block > s.chainHead ? { chainHead: block } : s)),
  setFrontLine: (value) => set({ frontLine: value }),

  /**
   * Add newly observed swaps. Returns only the ones that were actually new,
   * so the caller knows what to spawn on the field and what to sound for.
   */
  ingestSwaps: (swaps) => {
    if (swaps.length === 0) return [];

    const fresh: RealSwap[] = [];
    for (const s of swaps) {
      if (seenIds.has(s.id)) continue;
      seenIds.add(s.id);
      fresh.push(s);
    }
    if (fresh.length === 0) return [];

    // Bound the dedupe set alongside the feed so a long session can't leak.
    if (seenIds.size > FEED_CAPACITY * 6) {
      const keep = new Set<string>();
      const recent = [...fresh, ...get().feed].slice(0, FEED_CAPACITY * 2);
      for (const s of recent) keep.add(s.id);
      seenIds = keep;
    }

    set((state) => {
      const feed = [...fresh, ...state.feed]
        .sort((a, b) => b.timestamp - a.timestamp || b.blockNumber - a.blockNumber)
        .slice(0, FEED_CAPACITY);

      const totals = { ...state.totals };
      const perPool = new Map<string, number>();
      for (const s of fresh) {
        if (s.usd === null) totals.unpricedCount++;
        if (s.side === 'buy') {
          totals.buyCount++;
          totals.buyUsd += s.usd ?? 0;
        } else {
          totals.sellCount++;
          totals.sellUsd += s.usd ?? 0;
        }
        if ((s.usd ?? 0) > (totals.biggest?.usd ?? 0)) totals.biggest = s;
        perPool.set(s.poolAddress, (perPool.get(s.poolAddress) ?? 0) + 1);
      }

      const pools = perPool.size
        ? state.pools.map((p) =>
            perPool.has(p.address)
              ? { ...p, observedSwaps: p.observedSwaps + (perPool.get(p.address) ?? 0) }
              : p,
          )
        : state.pools;

      return {
        feed,
        totals,
        pools,
        pressure: computePressure(feed, Math.floor(Date.now() / 1000)),
      };
    });

    return fresh;
  },

  noteDropped: (count) =>
    count > 0 ? set((s) => ({ droppedForRender: s.droppedForRender + count })) : undefined,

  toggleIntense: () => set((s) => ({ intense: !s.intense })),
  toggleSound: () => set((s) => ({ soundEnabled: !s.soundEnabled })),
  toggleHud: () => set((s) => ({ showHud: !s.showHud })),
  toggleFeed: () => set((s) => ({ showFeed: !s.showFeed })),
  togglePanels: () => set((s) => ({ showPanels: !s.showPanels })),
  toggleScaleMode: () =>
    set((s) => ({ scaleMode: s.scaleMode === 'adaptive' ? 'absolute' : 'adaptive' })),
  setTierScale: (tierScale) =>
    set((s) =>
      s.tierScale.tank === tierScale.tank &&
      s.tierScale.artillery === tierScale.artillery &&
      s.tierScale.nuke === tierScale.nuke &&
      s.tierScale.mode === tierScale.mode
        ? s
        : { tierScale },
    ),
  setLowPower: (value) => set({ lowPower: value }),

  cycleFx: () =>
    set((s) => ({
      fx: s.fx === 'lite' ? 'full' : s.fx === 'full' ? 'off' : 'lite',
    })),

  // Written once a second from the render loop; skipped when nothing moved so
  // a steady frame rate does not re-render the HUD every second for nothing.
  setRenderStats: (renderStats) =>
    set((s) =>
      s.renderStats.fps === renderStats.fps && s.renderStats.width === renderStats.width
        ? s
        : { renderStats },
    ),
}));

/** Recompute the rolling window on a timer so it decays even in a quiet market. */
export function refreshPressureWindow(): void {
  const { feed } = useBattleStore.getState();
  useBattleStore.setState({ pressure: computePressure(feed, Math.floor(Date.now() / 1000)) });
}

/** Stable key for the current battlefield, used to restart the engine. */
export function targetKey(t: BattleTarget): string {
  return t.kind === 'war' ? `war:${t.id}` : `${t.kind}:${t.address}`;
}
