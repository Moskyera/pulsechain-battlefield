'use client';

import { useEffect, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Scene } from './scene/Scene';
import { Hud } from './hud/Hud';
import { useDeviceTier } from '@/hooks/useDeviceTier';
import { targetKey, useBattleStore } from '@/store/battle';
import { battleEngine } from '@/lib/data/engine';
import { resetRuntime } from '@/lib/sim/runtime';
import { field } from '@/lib/sim/field';

/**
 * Application shell: owns the canvas and the data engine's lifecycle.
 *
 * The Canvas is mounted only after hydration. R3F needs a real DOM and a WebGL
 * context, so rendering it during SSR just throws; gating on a mounted flag is
 * simpler and more predictable than a dynamic import with `ssr: false`.
 */
export default function BattlefieldApp() {
  const tier = useDeviceTier();
  const [mounted, setMounted] = useState(false);
  const [glError, setGlError] = useState<string | null>(null);

  const target = useBattleStore((s) => s.target);
  const lowPower = useBattleStore((s) => s.lowPower);
  const setLowPower = useBattleStore((s) => s.setLowPower);

  useEffect(() => setMounted(true), []);

  // Adopt the detected device tier once, as a default the user can override.
  const [tierApplied, setTierApplied] = useState(false);
  useEffect(() => {
    if (!tier.ready || tierApplied) return;
    setLowPower(tier.lowPower);
    field.lowPower = tier.lowPower;
    setTierApplied(true);
  }, [tier.ready, tier.lowPower, tierApplied, setLowPower]);

  // One engine run per battlefield. Switching targets tears the old one down
  // completely — socket, polls and pool contexts — so nothing leaks across.
  // Keyed on the target's identity, not the object, so unrelated store updates
  // never restart the engine.
  const key = targetKey(target);
  useEffect(() => {
    resetRuntime();
    void battleEngine.start(useBattleStore.getState().target);
    return () => battleEngine.stop();
  }, [key]);

  return (
    <div className="app">
      {mounted && !glError && (
        <Canvas
          className="canvas"
          shadows={!lowPower}
          dpr={[1, tier.maxDpr]}
          camera={{ position: [0, 78, 96], fov: 46, near: 0.4, far: 900 }}
          gl={{
            antialias: !lowPower,
            powerPreference: 'high-performance',
            failIfMajorPerformanceCaveat: false,
          }}
          onCreated={({ gl }) => {
            const canvas = gl.domElement;
            canvas.addEventListener('webglcontextlost', (e) => {
              e.preventDefault();
              setGlError('WebGL context lost. Reload to redeploy the battlefield.');
            });
          }}
        >
          <Scene lowPower={lowPower} />
        </Canvas>
      )}

      {glError && (
        <div className="gl-error">
          <div className="boot-card">
            <h2>Renderer stopped</h2>
            <p className="boot-error">{glError}</p>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      )}

      <Hud compact={tier.compact} />
    </div>
  );
}
