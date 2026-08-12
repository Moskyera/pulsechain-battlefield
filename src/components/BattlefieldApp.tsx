'use client';

import { useEffect, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
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
/**
 * Benchmark handle, mounted only for `?bench=1`.
 *
 * Frame cost can't be sampled with requestAnimationFrame in a background tab —
 * the browser stops issuing frames. Exposing R3F's `advance` lets a profiler
 * drive full frames on demand (sim + draw), and `gl.getContext().finish()`
 * makes the GPU cost land inside the measurement instead of after it.
 */
function BenchHandle() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const advance = useThree((s) => s.advance);

  useEffect(() => {
    const w = window as unknown as { __bf?: unknown };
    w.__bf = { gl, scene, camera, advance };
    return () => {
      delete w.__bf;
    };
  }, [gl, scene, camera, advance]);

  return null;
}

export default function BattlefieldApp() {
  const tier = useDeviceTier();
  const [mounted, setMounted] = useState(false);
  const [glError, setGlError] = useState<string | null>(null);

  const target = useBattleStore((s) => s.target);
  const lowPower = useBattleStore((s) => s.lowPower);
  const setLowPower = useBattleStore((s) => s.setLowPower);

  const [bench, setBench] = useState(false);

  /**
   * Render resolution, adjusted at runtime.
   *
   * A fixed ceiling can't work across monitors: at device pixel ratio 2 on a
   * large display the scene shades four times as many pixels as at 1, and the
   * transparent ordnance overdraws several of those layers. Rather than guess,
   * start conservative and let the measured frame rate decide — a slightly
   * softer image at a steady 60 beats a sharp one that stutters.
   */
  const [dpr, setDpr] = useState(1);

  useEffect(() => {
    setMounted(true);
    setBench(new URLSearchParams(window.location.search).has('bench'));
  }, []);

  useEffect(() => {
    if (tier.ready) setDpr(Math.min(1.25, tier.maxDpr));
  }, [tier.ready, tier.maxDpr]);

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
          shadows={lowPower ? false : 'soft'}
          // The effect chain does its own ACES pass at the end, so the renderer
          // must not tone map first: doing both crushes the image twice. The
          // light scene has no chain, so it keeps the renderer's own.
          flat={!lowPower}
          dpr={dpr}
          // Closer than it used to sit: with the scenery gone there is nothing
          // to look at out there, and the armies are the point.
          camera={{ position: [0, 58, 74], fov: 46, near: 0.4, far: 620 }}
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
          {/* Trades resolution for frame rate, in both directions: drop when
              frames are being missed, climb back once there is headroom. */}
          <PerformanceMonitor
            factor={0.6}
            onDecline={() => setDpr((d) => Math.max(0.7, Math.round((d - 0.25) * 100) / 100))}
            onIncline={() => setDpr((d) => Math.min(tier.maxDpr, Math.round((d + 0.25) * 100) / 100))}
          />
          <Scene lowPower={lowPower} />
          {bench && <BenchHandle />}
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
