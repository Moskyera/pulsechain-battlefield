'use client';

import { useEffect } from 'react';
import { useBattleStore } from '@/store/battle';
import { audio } from '@/lib/audio/engine';
import { field } from '@/lib/sim/field';

/**
 * Scene toggles.
 *
 * Intense mode raises the animation energy and shake response — it changes how
 * the battle *looks*, never what the data says. Sound must be armed by a click
 * because browsers refuse to start an AudioContext without a gesture.
 */
export function Controls({ compact }: { compact: boolean }) {
  const intense = useBattleStore((s) => s.intense);
  const soundEnabled = useBattleStore((s) => s.soundEnabled);
  const showHud = useBattleStore((s) => s.showHud);
  const showFeed = useBattleStore((s) => s.showFeed);
  const showPanels = useBattleStore((s) => s.showPanels);
  const lowPower = useBattleStore((s) => s.lowPower);
  const toggleIntense = useBattleStore((s) => s.toggleIntense);
  const toggleSound = useBattleStore((s) => s.toggleSound);
  const toggleHud = useBattleStore((s) => s.toggleHud);
  const toggleFeed = useBattleStore((s) => s.toggleFeed);
  const togglePanels = useBattleStore((s) => s.togglePanels);
  const setLowPower = useBattleStore((s) => s.setLowPower);

  // Mirror render settings into the mutable field state the frame loop reads.
  useEffect(() => {
    field.intense = intense;
  }, [intense]);
  useEffect(() => {
    field.lowPower = lowPower;
  }, [lowPower]);

  const onSound = async () => {
    if (!soundEnabled) {
      const ok = await audio.enable();
      if (!ok) return;
    } else {
      audio.disable();
    }
    toggleSound();
  };

  return (
    <div className="controls">
      <button
        type="button"
        className={`ctrl ${intense ? 'on' : ''}`}
        onClick={toggleIntense}
        title="Raises animation energy and camera shake. Does not change any data."
      >
        {compact ? '⚡' : '⚡ INTENSE'}
      </button>

      <button
        type="button"
        className={`ctrl ${soundEnabled ? 'on' : ''}`}
        onClick={onSound}
        title="Synthesised impact audio. Browsers require a click to start audio."
      >
        {compact ? (soundEnabled ? '🔊' : '🔇') : soundEnabled ? '🔊 SOUND' : '🔇 SOUND'}
      </button>

      <button
        type="button"
        className={`ctrl ${lowPower ? 'on' : ''}`}
        onClick={() => setLowPower(!lowPower)}
        title="Lighter scene: fewer units, no shadows, no starfield. Auto-enabled on small or low-core devices."
      >
        {compact ? '🔋' : lowPower ? '🔋 LIGHT' : '🔋 FULL'}
      </button>

      {/* Hide just the transaction list, keeping the rest of the HUD. */}
      <button
        type="button"
        className={`ctrl ${showFeed ? 'on' : ''}`}
        onClick={toggleFeed}
        title="Show or hide the market feed (the transaction list)"
      >
        {compact ? '☰' : '☰ FEED'}
      </button>

      {/* Hide just the left-hand intel columns. */}
      <button
        type="button"
        className={`ctrl ${showPanels ? 'on' : ''}`}
        onClick={togglePanels}
        title="Show or hide the intel and enlisted-pool panels"
      >
        {compact ? '▤' : '▤ INTEL'}
      </button>

      <button
        type="button"
        className="ctrl"
        onClick={toggleHud}
        title="Hide the entire overlay for a clean view of the field"
      >
        {showHud ? '⤢' : '⤡'}
      </button>
    </div>
  );
}
