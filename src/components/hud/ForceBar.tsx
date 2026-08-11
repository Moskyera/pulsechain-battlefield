'use client';

import { useEffect, useRef } from 'react';
import { useBattleStore } from '@/store/battle';
import { runtime } from '@/lib/sim/runtime';
import { FRONT_TRAVEL } from '@/lib/sim/layout';
import { formatUsd } from '@/lib/util/format';

/**
 * Where a -1..1 reading sits across the bar.
 *
 * Deliberately the *same* mapping the ground uses, FRONT_TRAVEL and all: the
 * line on the field is clamped so a losing army never slides out behind the
 * HUD, and if the bar ignored that clamp the two would sit at visibly
 * different places for the same number, which is the whole complaint. The bar
 * is a plan view of the field, so it obeys the field's limits.
 */
const toTrackPct = (value: number) => 50 + value * 50 * FRONT_TRAVEL;

/**
 * The front line, read as a bar.
 *
 * This used to plot something else entirely: the five-minute buy/sell money
 * split, while the line on the field is price momentum blended with order flow
 * and then eased. Two readings of "who is winning" sitting next to each other,
 * disagreeing, with no way to tell which one the field was drawing.
 *
 * Now the track *is* the field's line. It reads `runtime.frontLine`, the exact
 * eased value the battlefield draws, through a raw animation frame writing
 * straight to the DOM: no React re-render sixty times a second, and no chance
 * of the bar and the ground drifting apart, because there is only one number.
 *
 * The five-minute money flow is still shown, as a tick on the same track, so
 * you can see the pressure that is pushing the line as well as where the line
 * has actually got to. When the two sit apart, that gap is the real story: flow
 * is leaning one way and the line has not been moved yet.
 */
export function ForceBar() {
  const pressure = useBattleStore((s) => s.pressure);

  const buyFillRef = useRef<HTMLDivElement>(null);
  const sellFillRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLElement>(null);

  const total = pressure.buyUsd + pressure.sellUsd;
  const hasFlow = total > 0;
  // Where the five-minute money flow alone would put the line, on the same
  // scale as the line itself so the two can be compared by eye.
  const flowPct = toTrackPct(hasFlow ? (pressure.buyUsd - pressure.sellUsd) / total : 0);

  useEffect(() => {
    let frame = 0;
    let last = Number.NaN;

    const tick = () => {
      const value = runtime.frontLine;
      const pct = toTrackPct(value);

      if (!(Math.abs(pct - last) < 0.08)) {
        last = pct;
        if (buyFillRef.current) buyFillRef.current.style.width = `${pct}%`;
        if (sellFillRef.current) sellFillRef.current.style.width = `${100 - pct}%`;
        if (markerRef.current) markerRef.current.style.left = `${pct}%`;
        const readout = readoutRef.current;
        if (readout) {
          readout.textContent =
            (value >= 0 ? 'BULLS +' : 'BEARS ') + (value * 100).toFixed(1) + '%';
          readout.className = value >= 0 ? 'buy' : 'sell';
        }
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="force-bar-wrap">
      <div className="force-head">
        <span className="force-title">FORCE BALANCE</span>
        <span className="force-window">held ground · live</span>
      </div>

      <div
        className="force-track live"
        title="The bar is the front line on the field: green is ground held by buyers, red by sellers. The notch is the last 5 minutes of money flow, which is the pressure pushing the line."
      >
        <div ref={buyFillRef} className="force-fill buy" style={{ width: '50%' }} />
        <div ref={sellFillRef} className="force-fill sell" style={{ width: '50%' }} />
        <div ref={markerRef} className="force-marker" style={{ left: '50%' }} />
        {hasFlow && <div className="force-flow" style={{ left: `${flowPct}%` }} />}
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
        <b ref={readoutRef} className="buy">
          BULLS +0.0%
        </b>
      </div>
    </div>
  );
}
