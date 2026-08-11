'use client';

import { useBattleStore } from '@/store/battle';
import { formatUsd } from '@/lib/util/format';

/**
 * Buy vs sell pressure over the last five minutes of real swaps.
 *
 * Computed from trades this session actually observed on-chain — not from an
 * aggregator's summary. When no trades have landed in the window the bar says
 * so rather than defaulting to a tidy 50/50.
 */
export function ForceBar() {
  const pressure = useBattleStore((s) => s.pressure);
  const frontLine = useBattleStore((s) => s.frontLine);

  const total = pressure.buyUsd + pressure.sellUsd;
  const hasFlow = total > 0;
  const buyPct = hasFlow ? (pressure.buyUsd / total) * 100 : 50;

  return (
    <div className="force-bar-wrap">
      <div className="force-head">
        <span className="force-title">FORCE BALANCE</span>
        <span className="force-window">last {Math.round(pressure.windowSec / 60)}m · observed swaps</span>
      </div>

      <div className={`force-track ${hasFlow ? '' : 'empty'}`}>
        <div className="force-fill buy" style={{ width: `${buyPct}%` }} />
        <div className="force-fill sell" style={{ width: `${100 - buyPct}%` }} />
        <div className="force-marker" style={{ left: `${buyPct}%` }} />
      </div>

      <div className="force-legend">
        <span className="buy">
          <b>{formatUsd(pressure.buyUsd)}</b>
          <em>{pressure.buyCount} buys</em>
        </span>
        {!hasFlow && <span className="force-idle">no trades in window</span>}
        <span className="sell">
          <b>{formatUsd(pressure.sellUsd)}</b>
          <em>{pressure.sellCount} sells</em>
        </span>
      </div>

      <div className="front-readout">
        <span>FRONT LINE</span>
        <b className={frontLine >= 0 ? 'buy' : 'sell'}>
          {frontLine >= 0 ? 'BULLS +' : 'BEARS '}
          {(frontLine * 100).toFixed(1)}%
        </b>
      </div>
    </div>
  );
}
