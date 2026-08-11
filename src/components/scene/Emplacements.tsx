'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Object3D, type InstancedMesh } from 'three';
import { field } from '@/lib/sim/field';
import { runtime } from '@/lib/sim/runtime';
import { KIT_BUY, KIT_SELL, launcherGeometry, tankGeometry } from '@/lib/sim/geometry';
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

/**
 * Per-piece jitter, hashed once instead of once per frame. Same reasoning as
 * the soldier table in Armies: these values are fixed for the life of the gun.
 */
function batteryJitter(seed: string): { settlePhase: number; yawJitter: number }[] {
  return BATTERY.map((_, i) => ({
    settlePhase: hashUnit(seed + i) * 6,
    yawJitter: hashSigned(seed + i + 'y') * 0.08,
  }));
}

export function Emplacements({ lowPower }: { lowPower: boolean }) {
  const buyTanks = useRef<InstancedMesh>(null);
  const sellTanks = useRef<InstancedMesh>(null);
  const buyLaunchers = useRef<InstancedMesh>(null);
  const sellLaunchers = useRef<InstancedMesh>(null);
  const buyMarkers = useRef<InstancedMesh>(null);
  const sellMarkers = useRef<InstancedMesh>(null);

  const dummy = useMemo(() => new Object3D(), []);
  const buyTank = useMemo(() => tankGeometry(KIT_BUY), []);
  const sellTank = useMemo(() => tankGeometry(KIT_SELL), []);
  const buyLauncher = useMemo(() => launcherGeometry(KIT_BUY), []);
  const sellLauncher = useMemo(() => launcherGeometry(KIT_SELL), []);
  const plating = useMemo(() => armourTexture(), []);
  const buyJitter = useMemo(() => batteryJitter('emp-g'), []);
  const sellJitter = useMemo(() => batteryJitter('emp-r'), []);

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
      jitter: buyJitter,
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
      jitter: sellJitter,
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
      emissiveIntensity={0.03}
      roughness={0.78}
      metalness={0.28}
    />
  );

  return (
    <group>
      <instancedMesh ref={buyTanks} args={[undefined, undefined, TANKS_PER_SIDE]} frustumCulled={false} castShadow={!lowPower}>
        <primitive object={buyTank} attach="geometry" />
        {armourMaterial(COLORS.buy)}
      </instancedMesh>
      <instancedMesh ref={sellTanks} args={[undefined, undefined, TANKS_PER_SIDE]} frustumCulled={false} castShadow={!lowPower}>
        <primitive object={sellTank} attach="geometry" />
        {armourMaterial(COLORS.sell)}
      </instancedMesh>

      <instancedMesh ref={buyLaunchers} args={[undefined, undefined, LAUNCHERS_PER_SIDE]} frustumCulled={false} castShadow={!lowPower}>
        <primitive object={buyLauncher} attach="geometry" />
        {armourMaterial(COLORS.buy)}
      </instancedMesh>
      <instancedMesh ref={sellLaunchers} args={[undefined, undefined, LAUNCHERS_PER_SIDE]} frustumCulled={false} castShadow={!lowPower}>
        <primitive object={sellLauncher} attach="geometry" />
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
  jitter: { settlePhase: number; yawJitter: number }[];
  dummy: Object3D;
  time: number;
  yaw: number;
}

function place(a: PlaceArgs): void {
  const { tanks, launchers, markers, active, side, dir, jitter, dummy, time, yaw } = a;
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
    const j = jitter[i];

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

    const settle = Math.sin(time * 0.8 + j.settlePhase) * 0.015;
    dummy.position.set(x - dir * kick * 2.6, settle + kick * 0.25, z);
    // Nose up under recoil, and a slight yaw slap.
    dummy.rotation.set(kick * 0.16 * -dir, yaw + j.yawJitter + kick * 0.05, 0);
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
      // Kept modest: the camera is closer than it used to be, and at the old
      // size these read as billboards floating over the guns.
      dummy.position.set(x - dir * recoil * 0.8, 3.1 + piece.scale * 0.45, z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1.0, 0.5, 0.1);
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
