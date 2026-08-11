'use client';

import { useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdaptiveDpr, OrbitControls, Stars } from '@react-three/drei';
import type { Group } from 'three';
import { runtime } from '@/lib/sim/runtime';
import { field } from '@/lib/sim/field';
import { COLORS, FIELD_HALF_Z } from '@/lib/sim/layout';
import { Terrain } from './Terrain';
import { Environment } from './Environment';
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

export function Scene({ lowPower }: { lowPower: boolean }) {
  return (
    <>
      {/* Warm daylight haze. The fog colour matches the sky dome's horizon so
          the ridgelines dissolve into it instead of hitting a hard edge — and
          the far distance has to stay inside the fog range or the hills simply
          render as a black band. */}
      <color attach="background" args={['#c6bca6']} />
      <fog attach="fog" args={['#c6bca6', 110, 430]} />

      {/* Lighting rig.
          A warm key from high front-left models the troops, a cool sky fill
          keeps the shadows from going black, and two dim coloured rims — green
          from the left, red from the right — separate the armies at a glance
          without tinting the soldiers themselves. */}
      <ambientLight intensity={0.55} />
      <hemisphereLight args={['#5a7ea6', '#141a12', 1.0]} />
      <directionalLight
        position={[-26, 46, 34]}
        intensity={2.1}
        color="#ffeed8"
        castShadow={!lowPower}
        shadow-mapSize-width={lowPower ? 512 : 2048}
        shadow-mapSize-height={lowPower ? 512 : 2048}
        shadow-camera-left={-FIELD_HALF_X - 12}
        shadow-camera-right={FIELD_HALF_X + 12}
        shadow-camera-top={FIELD_HALF_Z + 24}
        shadow-camera-bottom={-FIELD_HALF_Z - 24}
        shadow-camera-far={180}
        shadow-bias={-0.0012}
      />
      <directionalLight position={[30, 18, -26]} intensity={0.5} color="#9fc4ff" />
      {!lowPower && (
        <>
          <pointLight position={[-FIELD_HALF_X * 0.7, 9, 0]} color={COLORS.buy} intensity={70} distance={52} decay={2} />
          <pointLight position={[FIELD_HALF_X * 0.7, 9, 0]} color={COLORS.sell} intensity={70} distance={52} decay={2} />
        </>
      )}

      {!lowPower && <Stars radius={260} depth={60} count={1800} factor={5} saturation={0} fade speed={0.4} />}

      <ShakeGroup>
        <Environment lowPower={lowPower} />
        <Terrain lowPower={lowPower} />
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
        minDistance={14}
        maxDistance={180}
        minPolarAngle={0.15}
        maxPolarAngle={Math.PI / 2 - 0.06}
        enableDamping
        dampingFactor={0.08}
        rotateSpeed={0.6}
        zoomSpeed={0.8}
      />

      <AdaptiveDpr pixelated />
    </>
  );
}
