'use client';

import { useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { Environment, Lightformer, OrbitControls } from '@react-three/drei';
import type { Group } from 'three';
import { runtime } from '@/lib/sim/runtime';
import { field } from '@/lib/sim/field';
import { FIELD_HALF_Z } from '@/lib/sim/layout';
import { Terrain } from './Terrain';
import { Cinematics } from './Cinematics';
import { Scars } from './Scars';
import { Smoke } from './Smoke';
import { Emplacements } from './Emplacements';
import { Bases } from './Bases';
import { Armies } from './Armies';
import { FrontLine } from './FrontLine';
import { Combat } from './Combat';
import { FIELD_HALF_X } from '@/lib/sim/layout';
import type { FxLevel } from '@/store/battle';


/**
 * Camera shake.
 *
 * Applied to a group wrapping the battlefield rather than to the camera itself,
 * because moving the camera would fight OrbitControls for the same transform.
 * Visually identical, and the user keeps full control of the view mid-blast.
 *
 * The displacement is a sum of sines — deterministic, and cheaper than noise.
 */
function ShakeGroup({ children }: { children: ReactNode }) {
  const ref = useRef<Group>(null);

  useFrame(() => {
    const g = ref.current;
    if (!g) return;

    const s = runtime.combat.shake;
    if (s <= 0.001) {
      g.position.set(0, 0, 0);
      g.rotation.set(0, 0, 0);
      return;
    }

    const t = runtime.elapsed;
    const amp = Math.min(1.6, s) * (field.intense ? 1.6 : 1);
    g.position.set(
      Math.sin(t * 47.3) * amp * 0.42,
      Math.sin(t * 61.7) * amp * 0.3,
      Math.cos(t * 53.1) * amp * 0.42,
    );
    g.rotation.z = Math.sin(t * 39.5) * amp * 0.006;
  });

  return <group ref={ref}>{children}</group>;
}

/**
 * The battlefield, and nothing else.
 *
 * Everything here earns its frame time by showing real data: the ground, the
 * held territory, the armies, the gun line and the ordnance. The scenery that
 * used to ring the valley — ridgelines, tree lines, buildings, rocks, smoke
 * columns, a sky dome and a starfield — was pure decoration costing 13 draw
 * calls and ~25k triangles a frame, plus its own shadow casters. It is gone;
 * the fog now closes the horizon for free.
 *
 * Lighting is deliberately minimal for the same reason. Four point lights (two
 * over the field, one per base) meant every standard material paid for four
 * extra light evaluations on every pixel, at every resolution. The team read
 * comes from emissive materials and the tinted territory planes instead, which
 * cost nothing per pixel.
 */
export function Scene({ lowPower, fx }: { lowPower: boolean; fx: FxLevel }) {
  return (
    <>
      {/* Warm daylight haze. With the ridgelines gone the fog *is* the horizon:
          the ground plane dissolves into it well before its far edge. */}
      <color attach="background" args={['#c6bca6']} />
      {/* The default camera sits ~94 units out and the field's far edge ~112,
          so the haze starts past that and closes completely well before the
          ground plane ends: the horizon is a band of light, not a wall of
          dirt. */}
      <fog attach="fog" args={['#c6bca6', 118, 190]} />

      {/* Lighting rig: a warm key from high front-left models the troops, a cool
          sky fill keeps the shadows from going black. No point lights. */}
      <ambientLight intensity={0.62} />
      <hemisphereLight args={['#5a7ea6', '#141a12', 1.05]} />
      <directionalLight
        position={[-26, 46, 34]}
        intensity={2.2}
        color="#ffeed8"
        castShadow={!lowPower}
        // 1024 is plenty now that only the units and bases cast: the shadow
        // camera covers the field alone, so texel density is unchanged from the
        // old 2048 map that also had to cover a valley full of trees.
        shadow-mapSize-width={lowPower ? 512 : 1024}
        shadow-mapSize-height={lowPower ? 512 : 1024}
        shadow-camera-left={-FIELD_HALF_X - 8}
        shadow-camera-right={FIELD_HALF_X + 8}
        shadow-camera-top={FIELD_HALF_Z + 16}
        shadow-camera-bottom={-FIELD_HALF_Z - 16}
        shadow-camera-near={1}
        shadow-camera-far={140}
        shadow-bias={-0.0012}
        // Softens the shadow edge. drei's PCSS, which would vary the softness
        // with distance from the caster, injects shader code that calls
        // unpackRGBAToDepth on what is a depth texture in three 0.185: every
        // material then fails to compile and the whole scene renders white.
        // This is the part of it that works.
        shadow-radius={4}
      />
      <directionalLight position={[30, 18, -26]} intensity={0.55} color="#9fc4ff" />

      {/* Environment light, built in the browser rather than downloaded.
          Three panels stand in for a sky: a warm sun side, a cool opposite, and
          the ground bouncing light back up. Direct lights alone can only make
          metal brighter or darker, never reflective, so armour read as painted
          cardboard; this is what gives it something to reflect. Rendered once
          at 128px, so it costs nothing per frame. */}
      {!lowPower && (
        <Environment resolution={128} frames={1}>
          <Lightformer intensity={2.4} color="#fff1d8" position={[-14, 14, 8]} scale={[14, 14, 1]} />
          <Lightformer intensity={0.8} color="#a8c8ff" position={[14, 9, -10]} scale={[16, 10, 1]} />
          <Lightformer
            intensity={0.55}
            color="#c6bca6"
            position={[0, -8, 0]}
            scale={[26, 26, 1]}
            rotation-x={Math.PI / 2}
          />
        </Environment>
      )}

      <ShakeGroup>
        <Terrain lowPower={lowPower} />
        <Scars lowPower={lowPower} />
        <Bases lowPower={lowPower} />
        <Emplacements lowPower={lowPower} />
        <Armies lowPower={lowPower} />
        <FrontLine />
        <Combat lowPower={lowPower} />
        <Smoke lowPower={lowPower} />
      </ShakeGroup>

      <OrbitControls
        makeDefault
        enablePan={false}
        target={[0, 1.5, 0]}
        minDistance={12}
        maxDistance={120}
        minPolarAngle={0.15}
        maxPolarAngle={Math.PI / 2 - 0.06}
        enableDamping
        dampingFactor={0.08}
        rotateSpeed={0.6}
        zoomSpeed={0.8}
      />

      {/* Image treatment. Last, because it consumes everything above it. */}
      <Cinematics level={fx} />
    </>
  );
}
