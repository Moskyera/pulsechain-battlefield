'use client';

import { PRESET_TOKENS } from '@/lib/chain/constants';
import { useBattleStore } from '@/store/battle';

/**
 * Load / failure state.
 *
 * A battlefield with no data shows *nothing* rather than a plausible-looking
 * default. If the pools cannot be read from chain, the user gets the actual
 * error and a way out, not an empty field that looks like a quiet market.
 */
export function BootOverlay() {
  const boot = useBattleStore((s) => s.boot);
  const error = useBattleStore((s) => s.bootError);
  const target = useBattleStore((s) => s.target);
  const selectToken = useBattleStore((s) => s.selectToken);
  const warnings = useBattleStore((s) => s.warnings);

  const name =
    target.kind === 'token' ? target.symbol : target.kind === 'war' ? target.label : target.label;

  if (boot === 'ready') {
    return warnings.length > 0 ? (
      <div className="warning-strip">
        {warnings.slice(0, 4).map((w) => (
          <span key={w}>⚠ {w}</span>
        ))}
      </div>
    ) : null;
  }

  if (boot === 'error') {
    return (
      <div className="boot-overlay error">
        <div className="boot-card">
          <h2>Cannot deploy to {name}</h2>
          <p className="boot-error">{error}</p>
          <p className="boot-hint">
            This app renders only real PulseChain data, so it will not show a battlefield it cannot
            source. Check the address is a PulseChain token or AMM pool, or pick a preset.
          </p>
          <button
            type="button"
            onClick={() => selectToken(PRESET_TOKENS[0].address, PRESET_TOKENS[0].symbol)}
          >
            Deploy to {PRESET_TOKENS[0].symbol}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="boot-overlay">
      <div className="boot-card">
        <div className="boot-spinner" />
        <h2>Deploying to {name}</h2>
        <p className="boot-hint">
          {target.kind === 'war'
            ? `Mustering ${target.tokens.map((t) => t.symbol).join(' + ')} — every liquid pool of every coin, across every PulseChain DEX…`
            : target.kind === 'token'
              ? 'Enlisting every liquid pool across PulseChain DEXs — reading pool contracts, reserves and recent Swap logs…'
              : 'Reading pool contract, reserves and recent Swap logs from PulseChain…'}
        </p>
      </div>
    </div>
  );
}
