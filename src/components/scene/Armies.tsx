'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, Object3D, type InstancedMesh } from 'three';
import { field } from '@/lib/sim/field';
import { runtime } from '@/lib/sim/runtime';
import { soldierGeometry } from '@/lib/sim/geometry';
import { troopTexture } from '@/lib/sim/textures';
import { targetKey, useBattleStore } from '@/store/battle';
import { hashSigned, hashUnit, hashUnitSalted } from '@/lib/util/hash';
import { COLORS, FIELD_HALF_Z, GREEN_BASE_X, RED_BASE_X, frontLineToX } from '@/lib/sim/layout';

/**
 * The two standing armies, and their ambient small-arms fire.
 *
 * Movement: every soldier is an individual. He holds his own post — a
 * deterministic spot in the depth band behind the line — and wanders around it
 * on his own two-axis rhythm, at his own speed, with his own marching gait.
 * There are no ranks and no lanes; nobody is synchronised with anybody.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  AMBIENT FIRE IS COSMETIC. Read this before wiring anything to it.
 *
 *  The rifle fire below is on a timer, not on the chain. It exists so the
 *  battle looks alive between trades, and it is deliberately kept small and
 *  short-ranged so it can never be mistaken for a transaction.
 *
 *  It writes to NOTHING: no killfeed entry, no force bar, no session totals,
 *  no front-line movement, no explosions, no camera shake, no sound. Every
 *  one of those remains driven exclusively by real on-chain swaps.
 *
 *  Real trades still arrive as bright tracers, rockets, armour and blasts —
 *  see Combat.tsx. If it detonates, it was real.
 * ─────────────────────────────────────────────────────────────────────────
 */

export const MAX_UNITS_HIGH = 28;
export const MAX_UNITS_LOW = 16;

/** Seconds between one soldier's bursts (before per-soldier variation). */
const FIRE_INTERVAL_MIN = 1.6;
const FIRE_INTERVAL_SPAN = 3.4;
/** Fraction of the cycle a burst is actually visible. */
const BURST_FRACTION = 0.16;
/** How far an ambient round travels before it fades out. */
const AMBIENT_RANGE = 15;

/**
 * Everything about one soldier that never changes while he is on the field.
 *
 * These are all derived from his index and the battlefield seed, so they were
 * being re-hashed from freshly built strings on every single frame — seventeen
 * string allocations per soldier, forty soldiers, sixty times a second. The
 * numbers are identical every time; only the clock moves. Computing them once
 * per (seed, count) turns ~40,000 allocations a second into zero, which is what
 * the periodic hitches were made of.
 */
interface SoldierConst {
  postDepth: number;
  postZ: number;
  pushPeriod: number;
  pushOffset: number;
  pushReach: number;
  wanderRateX: number;
  wanderRateZ: number;
  wanderPhX: number;
  wanderPhZ: number;
  reach: number;
  gaitRate: number;
  gaitPhase: number;
  yawJitter: number;
  fireInterval: number;
  fireOffset: number;
  scale: number;
}

function buildSoldierTable(seed: string, count: number): SoldierConst[] {
  const table: SoldierConst[] = [];
  for (let i = 0; i < count; i++) {
    const s = seed + i;

    // Stratified placement, not a raw hash draw. Each soldier owns one slot in
    // depth and one in width, so an army always fills its ground evenly —
    // hashing both axes independently let whole squads land on top of each
    // other, which is exactly how one side ends up stacked in a heap.
    const depthSlot = (i + 0.5) / count;
    // 7 is coprime with any plausible count, so the width slot walks the field
    // out of step with the depth slot instead of forming a diagonal.
    const widthSlot = (((i * 7 + 3) % count) + 0.5) / count;

    table.push({
      postDepth: Math.pow(depthSlot, 0.75) + hashSigned(s + 'dj') * 0.05,
      postZ: (widthSlot - 0.5) * 2 * FIELD_HALF_Z * 0.95 + hashSigned(s + 'z') * 1.8,
      pushPeriod: 9 + hashUnit(s + 'pp') * 11,
      pushOffset: hashUnit(s + 'ph'),
      pushReach: 2 + hashUnit(s + 'pr') * 5,
      wanderRateX: 0.16 + hashUnitSalted(s, 21) * 0.3,
      wanderRateZ: 0.13 + hashUnitSalted(s, 22) * 0.27,
      wanderPhX: hashUnit(s + 'px') * Math.PI * 2,
      wanderPhZ: hashUnit(s + 'pz') * Math.PI * 2,
      reach: 1.4 + hashUnit(s + 'rr') * 2.2,
      gaitRate: 0.75 + hashUnitSalted(s, 23) * 0.5,
      gaitPhase: hashUnit(s + 'g') * Math.PI * 2,
      yawJitter: hashSigned(s + 'yaw') * 0.2,
      fireInterval: FIRE_INTERVAL_MIN + hashUnit(s + 'fi') * FIRE_INTERVAL_SPAN,
      fireOffset: hashUnit(s + 'fo'),
      scale: 1.42 + hashUnitSalted(s, 11) * 0.16,
    });
  }
  return table;
}

/** Rebuilds the constants only when the battlefield or the head count changes. */
function useSoldierTable() {
  const ref = useRef<{ key: string; table: SoldierConst[] }>({ key: '', table: [] });
  return (seed: string, count: number): SoldierConst[] => {
    const key = seed + '|' + count;
    if (ref.current.key !== key) {
      ref.current = { key, table: buildSoldierTable(seed, count) };
    }
    return ref.current.table;
  };
}

export function Armies({ lowPower }: { lowPower: boolean }) {
  const greenRef = useRef<InstancedMesh>(null);
  const redRef = useRef<InstancedMesh>(null);
  const greenTracers = useRef<InstancedMesh>(null);
  const redTracers = useRef<InstancedMesh>(null);
  const greenFlashes = useRef<InstancedMesh>(null);
  const redFlashes = useRef<InstancedMesh>(null);

  const dummy = useMemo(() => new Object3D(), []);
  const soldier = useMemo(() => soldierGeometry(), []);
  const cloth = useMemo(() => troopTexture(), []);
  const capacity = lowPower ? MAX_UNITS_LOW : MAX_UNITS_HIGH;

  const seed = useBattleStore((s) => targetKey(s.target));
  const greenTable = useSoldierTable();
  const redTable = useSoldierTable();

  useFrame((_, rawDelta) => {
    const dt = Math.min(rawDelta, 0.05);
    runtime.elapsed += dt;
    const t = runtime.elapsed;
    const frontX = frontLineToX(runtime.frontLine);
    const intense = field.intense;

    const greenCount = field.hasData ? Math.min(field.greenUnits, capacity) : 0;
    const redCount = field.hasData ? Math.min(field.redUnits, capacity) : 0;

    paintSide({
      mesh: greenRef.current,
      tracers: greenTracers.current,
      flashes: greenFlashes.current,
      count: greenCount,
      dir: -1,
      baseX: GREEN_BASE_X,
      frontX,
      table: greenTable(seed + ':g', greenCount),
      dummy,
      time: t,
      intense,
    });

    paintSide({
      mesh: redRef.current,
      tracers: redTracers.current,
      flashes: redFlashes.current,
      count: redCount,
      dir: 1,
      baseX: RED_BASE_X,
      frontX,
      table: redTable(seed + ':r', redCount),
      dummy,
      time: t,
      intense,
    });
  });

  const troopMaterial = (color: string) => (
    <meshStandardMaterial
      vertexColors
      map={cloth}
      emissive={color}
      // Enough to say which army, not enough to drown the baked detail: at 0.22
      // the fatigues, webbing, skin and gunmetal all read as one flat colour.
      emissiveIntensity={0.15}
      roughness={0.82}
      metalness={0.08}
    />
  );

  return (
    <group>
      <instancedMesh
        ref={greenRef}
        args={[undefined, undefined, capacity]}
        frustumCulled={false}
        castShadow={!lowPower}
        receiveShadow={!lowPower}
      >
        <primitive object={soldier} attach="geometry" />
        {troopMaterial(COLORS.buy)}
      </instancedMesh>

      <instancedMesh
        ref={redRef}
        args={[undefined, undefined, capacity]}
        frustumCulled={false}
        castShadow={!lowPower}
        receiveShadow={!lowPower}
      >
        <primitive object={soldier} attach="geometry" />
        {troopMaterial(COLORS.sell)}
      </instancedMesh>

      {/* Ambient rifle tracers — thin, dim and short, so they never read as a
          trade. Deliberately much smaller than the ordnance in Combat.tsx. */}
      <instancedMesh ref={greenTracers} args={[undefined, undefined, capacity]} frustumCulled={false}>
        <sphereGeometry args={[1, 5, 4]} />
        <meshBasicMaterial color="#d8ffb0" transparent opacity={0.55} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={redTracers} args={[undefined, undefined, capacity]} frustumCulled={false}>
        <sphereGeometry args={[1, 5, 4]} />
        <meshBasicMaterial color="#ffc2a8" transparent opacity={0.55} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </instancedMesh>

      {/* Muzzle flashes */}
      <instancedMesh ref={greenFlashes} args={[undefined, undefined, capacity]} frustumCulled={false}>
        <sphereGeometry args={[1, 6, 5]} />
        <meshBasicMaterial color="#fff0c0" transparent opacity={0.85} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={redFlashes} args={[undefined, undefined, capacity]} frustumCulled={false}>
        <sphereGeometry args={[1, 6, 5]} />
        <meshBasicMaterial color="#ffe0b0" transparent opacity={0.85} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

interface PaintArgs {
  mesh: InstancedMesh | null;
  tracers: InstancedMesh | null;
  flashes: InstancedMesh | null;
  count: number;
  /** -1 for the left (green) army, +1 for the right (red) army. */
  dir: -1 | 1;
  baseX: number;
  frontX: number;
  /** Per-soldier constants, built once per (seed, count). */
  table: SoldierConst[];
  dummy: Object3D;
  time: number;
  intense: boolean;
}

function paintSide(a: PaintArgs): void {
  const { mesh, tracers, flashes, count, dir, baseX, frontX, table, dummy, time, intense } = a;
  if (!mesh) return;

  mesh.count = count;
  if (count === 0) {
    mesh.instanceMatrix.needsUpdate = true;
    if (tracers) tracers.count = 0;
    if (flashes) flashes.count = 0;
    return;
  }

  /** Toward the enemy. `dir` points back to our own base. */
  const faceDir = -dir;
  // The army occupies the whole of its own ground, front line back to base,
  // rather than huddling in a strip behind the line.
  const band = Math.max(6, Math.abs(baseX - frontX) - 4);
  const gaitSpeed = intense ? 4.6 : 2.4;
  const gaitLift = intense ? 0.16 : 0.1;

  let tracerN = 0;
  let flashN = 0;

  for (let i = 0; i < count; i++) {
    const c = table[i];
    if (!c) continue;

    /* ---- this soldier's own post, and his own wander around it ---- */
    // Every soldier is trying to push. He works his way forward on his own
    // clock, then falls back and goes again — so the line is always straining
    // toward the enemy instead of standing still.
    const pushPhase = ((time + c.pushOffset * c.pushPeriod) % c.pushPeriod) / c.pushPeriod;
    // Slow advance over most of the cycle, quick fall-back at the end.
    const advance =
      pushPhase < 0.75 ? pushPhase / 0.75 : 1 - (pushPhase - 0.75) / 0.25;

    const postX = frontX + dir * (3 + c.postDepth * band) - dir * c.pushReach * advance;

    // Two independent slow oscillations, each with its own rate and phase, so
    // no two soldiers ever trace the same path or share a rhythm.
    const wx = Math.sin(time * c.wanderRateX + c.wanderPhX) * c.reach;
    const wz = Math.cos(time * c.wanderRateZ + c.wanderPhZ) * c.reach;

    // Marching gait: |sin| gives two footfalls per cycle. Each soldier steps at
    // his own tempo.
    const gait = time * gaitSpeed * c.gaitRate + c.gaitPhase;
    const lift = Math.abs(Math.sin(gait)) * gaitLift;
    const stride = Math.sin(gait) * (intense ? 0.34 : 0.2);

    // Nobody crosses the line of contact. The front line is the wall between
    // the two armies: green holds everything to its left, red everything to its
    // right, and the push above can strain against it but never through it.
    const rawX = postX + wx - dir * stride;
    const x = dir === -1 ? Math.min(rawX, frontX - 1.6) : Math.max(rawX, frontX + 1.6);
    const z = Math.max(-FIELD_HALF_Z, Math.min(FIELD_HALF_Z, c.postZ + wz));
    const scale = c.scale;

    /* ---- ambient burst timing (cosmetic; see the file header) ---- */
    const cycle = ((time + c.fireOffset * c.fireInterval) % c.fireInterval) / c.fireInterval;
    const firing = cycle < BURST_FRACTION;
    const burstT = firing ? cycle / BURST_FRACTION : 0;

    // A firing soldier squares up to the enemy and takes the recoil; otherwise
    // he scans his sector.
    const scan = firing ? 0 : Math.sin(time * 0.45 + c.wanderPhX) * 0.22;
    const yaw = (dir === -1 ? 0 : Math.PI) + c.yawJitter + scan;
    const recoil = firing ? Math.sin(burstT * Math.PI) * 0.07 : 0;

    dummy.position.set(x, lift, z);
    dummy.rotation.set(0, yaw, Math.sin(gait * 0.5) * (intense ? 0.05 : 0.025) - recoil);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);

    if (!firing) continue;

    // Muzzle sits at the end of the rifle, which the model holds out front.
    const muzzleX = x + faceDir * 0.95 * scale;
    const muzzleY = lift + 1.15 * scale;
    const muzzleZ = z + 0.03 * scale;

    if (flashes && flashN < flashes.instanceMatrix.count && burstT < 0.35) {
      const punch = 1 - burstT / 0.35;
      dummy.position.set(muzzleX, muzzleY, muzzleZ);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(0.34 * punch);
      dummy.updateMatrix();
      flashes.setMatrixAt(flashN++, dummy.matrix);
    }

    if (tracers && tracerN < tracers.instanceMatrix.count) {
      // The round streaks downrange and thins out as it goes.
      const travel = burstT * AMBIENT_RANGE;
      dummy.position.set(
        muzzleX + faceDir * travel,
        muzzleY - burstT * 0.35,
        muzzleZ + Math.sin(burstT * 2) * 0.1,
      );
      dummy.rotation.set(0, 0, 0);
      const fade = 1 - burstT;
      dummy.scale.set(0.085 * fade, 0.085 * fade, 0.55 * fade);
      dummy.updateMatrix();
      tracers.setMatrixAt(tracerN++, dummy.matrix);
    }
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (tracers) {
    tracers.count = tracerN;
    tracers.instanceMatrix.needsUpdate = true;
  }
  if (flashes) {
    flashes.count = flashN;
    flashes.instanceMatrix.needsUpdate = true;
  }
}
