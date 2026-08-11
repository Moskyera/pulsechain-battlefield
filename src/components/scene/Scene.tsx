'use client';

import { useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { Group } from 'three';
import { runtime } from '@/lib/sim/runtime';
import { field } from '@/lib/sim/field';
import { FIELD_HALF_Z } from '@/lib/sim/layout';
import { Terrain } from './Terrain';
import { Scars } from './Scars';
import { Emplacements } from './Emplacements';
import { Bases } from './Bases';
import { Armies } from './Armies';
import { FrontLine } from './FrontLine';
import { Combat } from './Combat';
import { FIELD_HALF_X } from '@/lib/sim/layout';


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
export function Scene({ lowPower }: { lowPower: boolean }) {
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
      />
      <directionalLight position={[30, 18, -26]} intensity={0.55} color="#9fc4ff" />

      <ShakeGroup>
        <Terrain lowPower={lowPower} />
        <Scars lowPower={lowPower} />
        <Bases lowPower={lowPower} />
        <Emplacements lowPower={lowPower} />
        <Armies lowPower={lowPower} />
        <FrontLine />
        <Combat lowPower={lowPower} />
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
    </>
  );
}
