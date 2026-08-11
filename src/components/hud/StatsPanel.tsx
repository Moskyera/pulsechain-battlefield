'use client';

import { useEffect, useState } from 'react';
import { useBattleStore } from '@/store/battle';
import { field } from '@/lib/sim/field';
import { runtime } from '@/lib/sim/runtime';
import { formatPercent, formatPrice, formatUsd } from '@/lib/util/format';

/**
 * Market and battlefield telemetry.
 *
 * Every row states where its number comes from. The wall figures in particular
 * are summed from each pool's actual on-chain holdings — the armies' real head
 * count, not a derived estimate.
 */
export function StatsPanel() {
  const focus = useBattleStore((s) => s.focus);
  const groupTotals = useBattleStore((s) => s.groupTotals);
  const pools = useBattleStore((s) => s.pools);
  const totals = useBattleStore((s) => s.totals);
  const dropped = useBattleStore((s) => s.droppedForRender);
  const target = useBattleStore((s) => s.target);

  // field.* and runtime.* are mutable module state outside React (the frame
  // loop writes them every frame); sample them on a light timer instead of
  // subscribing, so combat never re-renders the HUD.
  const [live, setLive] = useState({
    green: 0,
    red: 0,
    greenUsd: 0,
    redUsd: 0,
    spawned: 0,
    inFlight: 0,
  });
  useEffect(() => {
    const t = setInterval(
      () =>
        setLive({
          green: field.greenUnits,
          red: field.redUnits,
          greenUsd: field.greenStrengthUsd,
          redUsd: field.redStrengthUsd,
          spawned: runtime.spawned,
          inFlight: runtime.combat.activeProjectiles + runtime.combat.activeExplosions,
        }),
      600,
    );
    return () => clearInterval(t);
  }, []);

  const unpricedPools = pools.filter((p) => p.focusReserveUsd === null).length;

  return (
    <div className="stats-panel">
      <div className="panel-head">
        <span>BATTLEFIELD INTEL</span>
        <em>
          {target.kind === 'war'
            ? `${pools.length} pools · combined war`
            : target.kind === 'token'
              ? `${pools.length}-pool group`
              : 'single pool'}
        </em>
      </div>

      <div className="stat-grid">
        <Stat
          label={target.kind === 'war' ? 'COINS' : 'PRICE'}
          value={
            target.kind === 'war'
              ? String(new Set(pools.map((p) => p.focusSymbol)).size)
              : formatPrice(focus?.priceUsd ?? null)
          }
          sub={
            target.kind === 'war'
              ? Array.from(new Set(pools.map((p) => p.focusSymbol))).join(' ')
              : focus
                ? `${focus.symbol}/USD · liq-weighted`
                : 'unavailable'
          }
        />
        <Stat
          label="24H"
          value={formatPercent(focus?.priceChange24 ?? null)}
          tone={
            focus?.priceChange24 === null || focus?.priceChange24 === undefined
              ? undefined
              : focus.priceChange24 >= 0
                ? 'buy'
                : 'sell'
          }
          sub="deepest pool"
        />
        <Stat
          label="LIQUIDITY"
          value={formatUsd(groupTotals?.liquidityUsd ?? null)}
          sub={`across ${pools.length} pool${pools.length === 1 ? '' : 's'}`}
        />
        <Stat
          label="VOL 24H"
          value={formatUsd(groupTotals?.volume24Usd ?? null)}
          sub="all venues · DexScreener"
        />
      </div>

      <div className="army-block">
        <div className="army-row buy">
          <span className="army-label">BUY WALL</span>
          <span className="army-units">{live.green} units</span>
          <span className="army-usd">{formatUsd(live.greenUsd)}</span>
        </div>
        <div className="army-row sell">
          <span className="army-label">SELL WALL</span>
          <span className="army-units">{live.red} units</span>
          <span className="army-usd">{formatUsd(live.redUsd)}</span>
        </div>
        <div className="reserve-detail" title="Summed from every enlisted pool's on-chain holdings">
          <span>
            buy wall = counter-token reserves · sell wall = {focus?.symbol ?? 'focus'} reserves
          </span>
        </div>
      </div>

      <div className="stat-grid">
        <Stat
          label="SESSION BUYS"
          value={formatUsd(totals.buyUsd)}
          sub={`${totals.buyCount} swaps`}
          tone="buy"
        />
        <Stat
          label="SESSION SELLS"
          value={formatUsd(totals.sellUsd)}
          sub={`${totals.sellCount} swaps`}
          tone="sell"
        />
        <Stat
          label="LARGEST"
          value={formatUsd(totals.biggest?.usd ?? null)}
          sub={totals.biggest ? `${totals.biggest.tier} · ${totals.biggest.dexLabel}` : 'none yet'}
          tone={totals.biggest?.side === 'sell' ? 'sell' : totals.biggest ? 'buy' : undefined}
        />
        <Stat
          label="TXNS 24H"
          value={
            groupTotals
              ? (groupTotals.txns24.buys + groupTotals.txns24.sells).toLocaleString()
              : '—'
          }
          sub={
            groupTotals
              ? `${groupTotals.txns24.buys.toLocaleString()}B / ${groupTotals.txns24.sells.toLocaleString()}S`
              : 'unavailable'
          }
        />
      </div>

      <div className="provenance">
        <span
          className="live-counter"
          title="Live trades launched onto the field this session, and ordnance currently in flight or detonating. Anything above infantry tier is fired by one of the standing guns in the battery."
        >
          {live.spawned} fired · {live.inFlight} active
        </span>
        {unpricedPools > 0 && (
          <span title="Pools whose reserves could not be valued in USD; their swaps still render">
            {unpricedPools} pool{unpricedPools === 1 ? '' : 's'} unpriced
          </span>
        )}
        {totals.unpricedCount > 0 && (
          <span title="Swaps observed before a USD price was available; counted but never valued">
            {totals.unpricedCount} unpriced swaps
          </span>
        )}
        {dropped > 0 && (
          <span title="Real swaps recorded in the feed but not rendered, because the spawn queue was saturated">
            {dropped} not rendered
          </span>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'buy' | 'sell';
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${tone ?? ''}`}>{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}
