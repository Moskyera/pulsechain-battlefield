'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Object3D, type InstancedMesh } from 'three';
import { field } from '@/lib/sim/field';
import { runtime } from '@/lib/sim/runtime';
import { launcherGeometry, tankGeometry } from '@/lib/sim/geometry';
import { armourTexture } from '@/lib/sim/textures';
import { hashSigned, hashUnit } from '@/lib/util/hash';
import { BATTERY, LAUNCHER_INDICES, TANK_INDICES, batteryPlacement } from '@/lib/sim/battery';
import { COLORS } from '@/lib/sim/layout';
import type { Side } from '@/lib/data/types';

/**
 * The gun line: a fixed battery dug in behind each army.
 *
 * Six pieces a side, always the same order of battle:
 *   2 heavy tanks    closest to the line
 *   2 light tanks    a little further back
 *   2 rocket launchers  deepest
 *
 * They hold station — no wandering, no spawning in and out. The only movement
 * is the suspension settling and a recoil kick when the side actually fires a
 * heavy round, which is stamped on `runtime.lastHeavyFire` by a real trade of
 * tank tier or above.
 *
 * The battery keeps formation relative to the front line, so as the line moves
 * the guns displace with it rather than being left behind.
 */

/**
 * Fixed order of battle, dressed in a single line.
 *
 * Every piece shares one standoff distance so the battery forms a clean lane
 * abreast rather than a staggered column, and `lane` places it across the
 * field's width: heavy armour holding the centre, light armour on the
 * shoulders, rocket artillery anchoring both flanks.
 */
const TANKS_PER_SIDE = TANK_INDICES.length;
const LAUNCHERS_PER_SIDE = LAUNCHER_INDICES.length;

export function Emplacements({ lowPower }: { lowPower: boolean }) {
  const buyTanks = useRef<InstancedMesh>(null);
  const sellTanks = useRef<InstancedMesh>(null);
  const buyLaunchers = useRef<InstancedMesh>(null);
  const sellLaunchers = useRef<InstancedMesh>(null);
  const buyMarkers = useRef<InstancedMesh>(null);
  const sellMarkers = useRef<InstancedMesh>(null);

  const dummy = useMemo(() => new Object3D(), []);
  const tank = useMemo(() => tankGeometry(), []);
  const launcher = useMemo(() => launcherGeometry(), []);
  const plating = useMemo(() => armourTexture(), []);

  useFrame(() => {
    const t = runtime.elapsed;
    const active = field.hasData;

    place({
      tanks: buyTanks.current,
      launchers: buyLaunchers.current,
      markers: buyMarkers.current,
      active,
      side: 'buy',
      dir: -1,
      seed: 'emp-g',
      dummy,
      time: t,
      yaw: 0,
    });

    place({
      tanks: sellTanks.current,
      launchers: sellLaunchers.current,
      markers: sellMarkers.current,
      active,
      side: 'sell',
      dir: 1,
      seed: 'emp-r',
      dummy,
      time: t,
      yaw: Math.PI,
    });
  });

  const armourMaterial = (color: string) => (
    <meshStandardMaterial
      vertexColors
      map={plating}
      emissive={color}
      emissiveIntensity={0.18}
      roughness={0.78}
      metalness={0.28}
    />
  );

  return (
    <group>
      <instancedMesh ref={buyTanks} args={[undefined, undefined, TANKS_PER_SIDE]} frustumCulled={false} castShadow={!lowPower}>
        <primitive object={tank} attach="geometry" />
        {armourMaterial(COLORS.buy)}
      </instancedMesh>
      <instancedMesh ref={sellTanks} args={[undefined, undefined, TANKS_PER_SIDE]} frustumCulled={false} castShadow={!lowPower}>
        <primitive object={tank} attach="geometry" />
        {armourMaterial(COLORS.sell)}
      </instancedMesh>

      <instancedMesh ref={buyLaunchers} args={[undefined, undefined, LAUNCHERS_PER_SIDE]} frustumCulled={false} castShadow={!lowPower}>
        <primitive object={launcher} attach="geometry" />
        {armourMaterial(COLORS.buy)}
      </instancedMesh>
      <instancedMesh ref={sellLaunchers} args={[undefined, undefined, LAUNCHERS_PER_SIDE]} frustumCulled={false} castShadow={!lowPower}>
        <primitive object={launcher} attach="geometry" />
        {armourMaterial(COLORS.sell)}
      </instancedMesh>

      {/* Identification pennants flying over the gun line */}
      <instancedMesh ref={buyMarkers} args={[undefined, undefined, BATTERY.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color={COLORS.buy} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={sellMarkers} args={[undefined, undefined, BATTERY.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color={COLORS.sell} toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

interface PlaceArgs {
  tanks: InstancedMesh | null;
  launchers: InstancedMesh | null;
  markers: InstancedMesh | null;
  active: boolean;
  side: Side;
  dir: -1 | 1;
  seed: string;
  dummy: Object3D;
  time: number;
  yaw: number;
}

function place(a: PlaceArgs): void {
  const { tanks, launchers, markers, active, side, dir, seed, dummy, time, yaw } = a;
  if (!tanks || !launchers) return;

  if (!active) {
    tanks.count = 0;
    launchers.count = 0;
    tanks.instanceMatrix.needsUpdate = true;
    launchers.instanceMatrix.needsUpdate = true;
    if (markers) {
      markers.count = 0;
      markers.instanceMatrix.needsUpdate = true;
    }
    return;
  }

  let tankN = 0;
  let launcherN = 0;
  let markerN = 0;

  for (let i = 0; i < BATTERY.length; i++) {
    const piece = BATTERY[i];
    const s = seed + i;

    // Placement comes from the shared battery definition — the same call the
    // combat system uses to decide where a round leaves from, so the muzzle
    // flash and the shell always agree with the model on screen.
    const { x, z } = batteryPlacement(i, side, runtime.frontLine);

    // Only the gun that actually fired recoils. Slow enough to read at this
    // camera distance — a fast, small kick is invisible and the battery looks
    // like it is doing nothing when a trade lands.
    const since = time - runtime.batteryFire[side][i];
    const recoil = Math.max(0, 1 - since * 1.7);
    // Sharp kick back, then a slower settle forward.
    const kick = recoil * recoil;

    const settle = Math.sin(time * 0.8 + hashUnit(s) * 6) * 0.015;
    dummy.position.set(x - dir * kick * 2.6, settle + kick * 0.25, z);
    // Nose up under recoil, and a slight yaw slap.
    dummy.rotation.set(
      kick * 0.16 * -dir,
      yaw + hashSigned(s + 'y') * 0.08 + kick * 0.05,
      0,
    );
    dummy.scale.setScalar(piece.scale);
    dummy.updateMatrix();

    if (piece.kind === 'launcher') {
      if (launcherN < LAUNCHERS_PER_SIDE) launchers.setMatrixAt(launcherN++, dummy.matrix);
    } else if (tankN < TANKS_PER_SIDE) {
      tanks.setMatrixAt(tankN++, dummy.matrix);
    }

    // Identification pennant above each piece. The vehicles are deliberately
    // dark gunmetal so they read against tan ground, which leaves nothing
    // saying whose they are — this does, and it also flags where the guns are.
    if (markers && markerN < BATTERY.length) {
      dummy.position.set(x - dir * recoil * 0.8, 3.5 + piece.scale * 0.5, z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1.5, 0.75, 0.14);
      dummy.updateMatrix();
      markers.setMatrixAt(markerN++, dummy.matrix);
    }
  }

  tanks.count = tankN;
  launchers.count = launcherN;
  tanks.instanceMatrix.needsUpdate = true;
  launchers.instanceMatrix.needsUpdate = true;
  if (markers) {
    markers.count = markerN;
    markers.instanceMatrix.needsUpdate = true;
  }
}
