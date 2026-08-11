'use client';

import { useBattleStore } from '@/store/battle';
import { formatBlock } from '@/lib/util/format';
import type { SourceId, SourceState } from '@/lib/data/types';

const SOURCE_LABELS: Record<SourceId, string> = {
  websocket: 'WSS',
  rpc: 'RPC',
  dexscreener: 'DEX',
  subgraph: 'GRAPH',
};

const SOURCE_TITLES: Record<SourceId, string> = {
  websocket: 'PulseChain RPC WebSocket — live Swap and Sync events',
  rpc: 'PulseChain JSON-RPC — reserves, swap backfill, block timestamps',
  dexscreener: 'DexScreener — USD price, liquidity, volume',
  subgraph: 'PulseX subgraph — indexed reserves and swap history',
};

const STATE_CLASS: Record<SourceState, string> = {
  live: 'ok',
  connecting: 'pending',
  degraded: 'warn',
  error: 'bad',
  idle: 'idle',
};

/**
 * The provenance bar.
 *
 * Every number on screen comes from one of these four sources, so their health
 * is shown permanently rather than hidden behind a menu. If a source degrades,
 * the user sees exactly which one and why.
 */
export function StatusBar() {
  const sources = useBattleStore((s) => s.sources);
  const chainHead = useBattleStore((s) => s.chainHead);
  const pools = useBattleStore((s) => s.pools);

  // Name the venues in the fight, deduplicated — a token battlefield routinely
  // spans several pools on the same DEX.
  const venues = Array.from(new Set(pools.map((p) => p.dexLabel.split(' ')[0])));
  const venueLabel =
    venues.length === 0
      ? null
      : venues.length <= 3
        ? venues.join(' · ')
        : `${venues.slice(0, 2).join(' · ')} +${venues.length - 2}`;

  // "Live" requires a working path to actual chain events — not merely a
  // successful price poll, which would still be real but not real-time.
  const isLive = sources.websocket.state === 'live' || sources.rpc.state === 'live';
  const anyDegraded = Object.values(sources).some(
    (s) => s.state === 'degraded' || s.state === 'error',
  );

  return (
    <div className="status-bar">
      <div className={`live-pill ${isLive ? 'live' : 'offline'}`}>
        <span className="live-dot" />
        <span className="live-text">
          {isLive ? 'LIVE' : 'CONNECTING'}
          <em>{isLive ? ' · REAL PULSECHAIN DATA' : ' · PULSECHAIN'}</em>
        </span>
      </div>

      <div className="source-chips">
        {(Object.keys(SOURCE_LABELS) as SourceId[]).map((id) => {
          const s = sources[id];
          const detail = s.error ?? s.detail ?? s.state;
          return (
            <span
              key={id}
              className={`chip ${STATE_CLASS[s.state]}`}
              title={`${SOURCE_TITLES[id]}\nStatus: ${s.state}${detail ? `\n${detail}` : ''}`}
            >
              <i />
              {SOURCE_LABELS[id]}
            </span>
          );
        })}
      </div>

      <div className="status-meta">
        {venueLabel && (
          <span className="dex-label" title={pools.map((p) => p.dexLabel).join('\n')}>
            {venueLabel}
          </span>
        )}
        <span className="block-label" title="Chain head observed by this session">
          {formatBlock(chainHead)}
        </span>
      </div>

      {anyDegraded && (
        <div className="degraded-note">
          {Object.entries(sources)
            .filter(([, s]) => s.error)
            .map(([id, s]) => `${SOURCE_LABELS[id as SourceId]}: ${s.error}`)
            .join(' · ')}
        </div>
      )}
    </div>
  );
}
