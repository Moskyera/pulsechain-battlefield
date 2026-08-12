'use client';

import { useEffect, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
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

/**
 * Frame cap.
 *
 * The scene was rendering on every animation frame the browser offered, which
 * on a high refresh monitor means 144 or 240 full renders a second, each one
 * paying for the whole effect chain. Nothing here needs that: the data arrives
 * in blocks, the front line eases over seconds, and no eye reads a soldier's
 * stride at 240Hz. Capping the render rate is worth more than any single
 * optimisation in this file, because it divides the entire frame cost.
 *
 * R3F renders on demand; this drives that demand at a fixed rate.
 */
function FrameLimiter({ fps, onSample }: { fps: number; onSample: (fps: number) => void }) {
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    let frame = 0;
    let last = -Infinity;
    let drawn = 0;
    let windowStart = -Infinity;

    const tick = (now: number) => {
      // A window left open on a second monitor while you work in something
      // else was still rendering at the full rate. Unfocused, it idles.
      const active = document.hasFocus();
      const target = active ? fps : 8;
      // A hair under the interval, so a monitor running near the cap is not
      // pushed to alternate between one frame and two.
      const step = 1000 / target - 1.5;

      if (now - last >= step) {
        last = now;
        drawn++;
        invalidate();
      }

      if (now - windowStart >= 1000) {
        if (windowStart > 0) onSample(drawn);
        windowStart = now;
        drawn = 0;
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [fps, invalidate, onSample]);

  return null;
}

export default function BattlefieldApp() {
  const tier = useDeviceTier();
  const [mounted, setMounted] = useState(false);
  const [glError, setGlError] = useState<string | null>(null);

  const target = useBattleStore((s) => s.target);
  const lowPower = useBattleStore((s) => s.lowPower);
  const fx = useBattleStore((s) => s.fx);
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
  const [, setRenderFps] = useState(0);
  const setStats = useBattleStore((s) => s.setRenderStats);

  useEffect(() => {
    setMounted(true);
    setBench(new URLSearchParams(window.location.search).has('bench'));
  }, []);

  /**
   * Resolution ceiling.
   *
   * The effect chain is per-pixel and the passes stack, so its cost grows with
   * the square of the window. Rendering above 1:1 while it is running multiplies
   * that for a sharpness the antialiasing pass is already providing, which is a
   * bad trade on any screen and a punishing one on a large screen.
   */
  const chainOn = !lowPower && fx !== 'off';
  /**
   * Shadows are a second pass over every casting object in the scene, every
   * frame, before anything is shaded. They are the most expensive thing left
   * once the effect chain is off, so they now travel with it: the plain scene
   * is genuinely plain, and turning the picture on brings them back.
   */
  const shadowsOn = chainOn;
  /**
   * Never above one rendered pixel per screen pixel.
   *
   * This was allowed to climb to 1.75x, which triples the pixel count on a
   * high-density display, and every one of those pixels pays for shadows,
   * lighting and any effect that is running. On a scene of flat-shaded blocks
   * that buys almost no visible sharpness, and it was the largest remaining
   * cost by some distance. The monitor below can still drop it under 1 when a
   * machine is struggling; it can no longer go above.
   */
  const dprCeiling = 1;
  void dprCeiling;

  useEffect(() => {
    if (tier.ready) setDpr(Math.min(dprCeiling, tier.maxDpr));
  }, [tier.ready, tier.maxDpr, dprCeiling]);

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
          // Rendering is driven by FrameLimiter rather than by the display's
          // refresh rate. See the note there.
          frameloop="demand"
          shadows={shadowsOn ? 'soft' : false}
          // The effect chain does its own ACES pass at the end, so the renderer
          // must not tone map first: doing both crushes the image twice. With
          // no chain there is nothing downstream to do it, so the renderer
          // keeps its own. This has to follow the chain, not the power mode.
          flat={chainOn}
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
          <FrameLimiter
            // Half the frames is half the work, and nothing here is a shooter.
            fps={chainOn ? 45 : 30}
            onSample={(f) => {
              setRenderFps(f);
              const c = document.querySelector('canvas');
              setStats({
                fps: f,
                width: c ? c.width : 0,
                height: c ? c.height : 0,
                dpr,
              });
            }}
          />
          <Scene lowPower={lowPower} fx={lowPower ? 'off' : fx} />
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
