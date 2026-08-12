'use client';

import { useBattleStore } from '@/store/battle';
import { StatusBar } from './StatusBar';
import { BattlePicker } from './BattlePicker';
import { Controls } from './Controls';
import { ForceBar } from './ForceBar';
import { KillFeed } from './KillFeed';
import { StatsPanel } from './StatsPanel';
import { PoolsPanel } from './PoolsPanel';
import { BootOverlay } from './BootOverlay';
import { FlashOverlay } from './FlashOverlay';
import { ADAPTIVE_MIN_SAMPLES } from '@/lib/data/classify';
import { formatUsd } from '@/lib/util/format';

/**
 * Legend showing exactly which real USD size becomes which unit — with the
 * *live* cutoffs, so the adaptive ladder is never a black box.
 */
function TierLegend() {
  const scale = useBattleStore((s) => s.tierScale);
  const mode = useBattleStore((s) => s.scaleMode);
  const toggleScaleMode = useBattleStore((s) => s.toggleScaleMode);

  const adaptive = mode === 'adaptive';
  const calibrating = adaptive && scale.samples < ADAPTIVE_MIN_SAMPLES;

  const title = adaptive
    ? `ADAPTIVE: unit class is the trade's rank against the ${scale.samples} most recent real swaps on this battlefield ` +
      `(top 20% / 5% / 0.7%). Trade sizes are real either way — this only changes which bucket they land in.\n\n` +
      `Why: the median PulseChain trade is a few dollars, so on the fixed $500/$5K/$25K ladder almost every trade is infantry ` +
      `and the nuke tier effectively never fires.\n\nClick to switch to absolute USD.`
    : `ABSOLUTE: fixed USD ladder ($500 / $5K / $25K).\n\nOn PulseChain this means near-total infantry — measured over 8h, ` +
      `trades above $25K did not occur at all.\n\nClick to switch to adaptive.`;

  return (
    <button type="button" className="tier-legend" onClick={toggleScaleMode} title={title}>
      <span className="legend-mode" data-mode={mode}>
        {adaptive ? (calibrating ? 'CALIBRATING' : 'ADAPTIVE') : 'ABSOLUTE'}
      </span>
      <span data-tier="infantry">▪ &lt;{formatUsd(scale.tank)}</span>
      <span data-tier="tank">◆ {formatUsd(scale.tank)}+</span>
      <span data-tier="artillery">▲ {formatUsd(scale.artillery)}+</span>
      <span data-tier="nuke">☢ {formatUsd(scale.nuke)}+</span>
    </button>
  );
}

export function Hud({
  compact,
  software = false,
  renderer = '',
}: {
  compact: boolean;
  software?: boolean;
  renderer?: string;
}) {
  const showHud = useBattleStore((s) => s.showHud);
  const showFeed = useBattleStore((s) => s.showFeed);
  const showPanels = useBattleStore((s) => s.showPanels);
  const target = useBattleStore((s) => s.target);
  const focus = useBattleStore((s) => s.focus);
  const pools = useBattleStore((s) => s.pools);

  const coins = Array.from(new Set(pools.map((p) => p.focusSymbol)));

  const title =
    target.kind === 'war'
      ? target.label
      : target.kind === 'token'
        ? (focus?.symbol ?? target.symbol)
        : (focus?.symbol ?? target.label);

  const subtitle =
    target.kind === 'war'
      ? `${coins.join(' + ') || '—'} · ${pools.length} pools`
      : target.kind === 'token'
        ? `${pools.length || '—'} pools · all DEXs`
        : (pools[0]?.dexLabel ?? 'single pool');

  return (
    <>
      <FlashOverlay />
      <BootOverlay />

      {/* A browser that has fallen back to CPU rasterising still renders
          everything, so nothing announces itself except the fans. Say it. */}
      {software && (
        <div className="software-warning" role="status">
          <b>This browser is drawing without your graphics card.</b>
          <span>
            WebGL has fallen back to software rendering{renderer ? ` (${renderer})` : ''}, so every
            frame is being drawn by the CPU. Restart the browser, and check that hardware
            acceleration is enabled in its settings. The battlefield is running in its lightest
            mode meanwhile.
          </span>
        </div>
      )}

      <div className={['hud', showHud ? '' : 'hidden', compact ? 'compact' : ''].filter(Boolean).join(' ')}>
        <header className="hud-top">
          <div className="brand">
            <h1>
              PULSECHAIN <b>BATTLEFIELD</b>
            </h1>
            <span className="pair-name">
              {title}
              <em className="pair-sub"> · {subtitle}</em>
            </span>
          </div>
          <StatusBar />
          <Controls compact={compact} />
        </header>

        <div className="hud-toolbar">
          <BattlePicker compact={compact} />
          <TierLegend />
        </div>

        {showPanels && (
          <aside className="hud-left">
            <StatsPanel />
            <PoolsPanel />
          </aside>
        )}

        {showFeed && (
          <aside className="hud-right">
            <KillFeed compact={compact} />
          </aside>
        )}

        <footer className="hud-bottom">
          <ForceBar />
        </footer>
      </div>

      {!showHud && (
        <button type="button" className="hud-restore" onClick={() => useBattleStore.getState().toggleHud()}>
          SHOW HUD
        </button>
      )}
    </>
  );
}
