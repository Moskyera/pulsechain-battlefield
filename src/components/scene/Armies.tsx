'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, Object3D, type InstancedMesh } from 'three';
import { field } from '@/lib/sim/field';
import { drainBlasts, runtime } from '@/lib/sim/runtime';
import { KIT_BUY, KIT_SELL, soldierGeometry } from '@/lib/sim/geometry';
import type { Side } from '@/lib/data/types';
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
 *
 * CASUALTIES AND REINFORCEMENTS
 *
 * How many soldiers a side fields is, as before, its real liquidity. What is
 * new is that the number no longer changes by silent teleport: when the count
 * drops the missing men fall where they stood and lie there, and when it rises
 * the new ones march up from their own base and take position.
 *
 * Men are also knocked down by real detonations landing near them — the blast
 * is a real trade (Combat.tsx records it), the choreography around it is
 * dramatisation, exactly like the ambient fire above. A knocked-down man is
 * replaced a few seconds later if his side's liquidity still supports him, so
 * the standing count always converges back on the real number.
 */

export const MAX_UNITS_HIGH = 28;
export const MAX_UNITS_LOW = 16;

/** Corpses render in the same instanced mesh as the living: no extra draw call. */
const CORPSE_CAPACITY = 22;
/** Topple animation, then how long a body lies there before it sinks away. */
const FALL_TIME = 0.75;
const CORPSE_LIFE = 15;
const CORPSE_SINK = 2;
/** A man knocked down is off the field this long before a replacement starts. */
const REPLACE_DELAY = 2.4;
/** How long reinforcements take to march from their base to their post. */
const ARRIVE_TIME = 2.6;

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

/** Where a man is in his tour: marching up, holding the line, or down. */
type SlotPhase = 'out' | 'arriving' | 'standing';

interface SoldierSlot {
  phase: SlotPhase;
  /** `runtime.elapsed` when the current phase began. */
  since: number;
  /** Earliest time a replacement may start marching up. */
  readyAt: number;
}

interface Corpse {
  x: number;
  z: number;
  yaw: number;
  fellAt: number;
  /** Which way he toppled, so a line of dead men doesn't lie in lockstep. */
  roll: number;
}

interface SideState {
  slots: SoldierSlot[];
  corpses: Corpse[];
  corpseHead: number;
  blastCursor: number;
  /** Live positions, kept so a blast can find who was standing where. */
  posX: Float32Array;
  posZ: Float32Array;
}

function makeSideState(capacity: number): SideState {
  return {
    slots: Array.from({ length: capacity }, () => ({
      phase: 'out' as SlotPhase,
      since: 0,
      readyAt: 0,
    })),
    corpses: Array.from({ length: CORPSE_CAPACITY }, () => ({
      x: 0,
      z: 0,
      yaw: 0,
      fellAt: -999,
      roll: 1,
    })),
    corpseHead: 0,
    blastCursor: 0,
    posX: new Float32Array(capacity),
    posZ: new Float32Array(capacity),
  };
}

/** Lay a man down where he stood. */
function fell(state: SideState, index: number, x: number, z: number, yaw: number, time: number): void {
  const slot = state.slots[index];
  if (slot.phase === 'out') return;
  slot.phase = 'out';
  slot.since = time;
  slot.readyAt = time + REPLACE_DELAY;

  const corpse = state.corpses[state.corpseHead % CORPSE_CAPACITY];
  state.corpseHead++;
  corpse.x = x;
  corpse.z = z;
  corpse.yaw = yaw;
  corpse.fellAt = time;
  corpse.roll = index % 2 === 0 ? 1 : -1;
}

export function Armies({ lowPower }: { lowPower: boolean }) {
  const greenRef = useRef<InstancedMesh>(null);
  const redRef = useRef<InstancedMesh>(null);
  const greenTracers = useRef<InstancedMesh>(null);
  const redTracers = useRef<InstancedMesh>(null);
  const greenFlashes = useRef<InstancedMesh>(null);
  const redFlashes = useRef<InstancedMesh>(null);

  const dummy = useMemo(() => new Object3D(), []);
  const greenSoldier = useMemo(() => soldierGeometry(KIT_BUY), []);
  const redSoldier = useMemo(() => soldierGeometry(KIT_SELL), []);
  const cloth = useMemo(() => troopTexture(), []);
  const capacity = lowPower ? MAX_UNITS_LOW : MAX_UNITS_HIGH;

  const seed = useBattleStore((s) => targetKey(s.target));
  const greenTable = useSoldierTable();
  const redTable = useSoldierTable();

  const greenState = useMemo(() => makeSideState(capacity), [capacity]);
  const redState = useMemo(() => makeSideState(capacity), [capacity]);

  // A new battlefield is a new war: nobody carries over.
  const lastSeed = useRef(seed);
  if (lastSeed.current !== seed) {
    lastSeed.current = seed;
    for (const s of [greenState, redState]) {
      for (const slot of s.slots) slot.phase = 'out';
      for (const c of s.corpses) c.fellAt = -999;
      s.blastCursor = runtime.blastSeq;
    }
  }

  useFrame((_, rawDelta) => {
    const dt = Math.min(rawDelta, 0.05);
    runtime.elapsed += dt;
    const t = runtime.elapsed;
    const frontX = frontLineToX(runtime.frontLine);
    const intense = field.intense;

    const greenCount = field.hasData ? Math.min(field.greenUnits, capacity) : 0;
    const redCount = field.hasData ? Math.min(field.redUnits, capacity) : 0;

    // Which way the line is being driven, from -1 (this side is being pushed
    // back) to +1 (this side is pushing). Drives posture, pace and bounding.
    const drive = runtime.frontLineVelocity * 6;

    paintSide({
      mesh: greenRef.current,
      tracers: greenTracers.current,
      flashes: greenFlashes.current,
      count: greenCount,
      dir: -1,
      baseX: GREEN_BASE_X,
      frontX,
      table: greenTable(seed + ':g', greenCount),
      state: greenState,
      side: 'buy',
      advance: Math.max(-1, Math.min(1, drive)),
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
      state: redState,
      side: 'sell',
      advance: Math.max(-1, Math.min(1, -drive)),
      dummy,
      time: t,
      intense,
    });
  });

  // Uniforms now come from the geometry's baked colours and the side is told by
  // the helmet band and armband, so the emissive wash that used to turn every
  // man into a solid block of team colour is down to a faint rim.
  const troopMaterial = (color: string) => (
    <meshStandardMaterial
      vertexColors
      map={cloth}
      emissive={color}
      emissiveIntensity={0.035}
      roughness={0.82}
      metalness={0.08}
    />
  );

  return (
    <group>
      <instancedMesh
        ref={greenRef}
        args={[undefined, undefined, capacity + CORPSE_CAPACITY]}
        frustumCulled={false}
        castShadow={!lowPower}
        receiveShadow={!lowPower}
      >
        <primitive object={greenSoldier} attach="geometry" />
        {troopMaterial(COLORS.buy)}
      </instancedMesh>

      <instancedMesh
        ref={redRef}
        args={[undefined, undefined, capacity + CORPSE_CAPACITY]}
        frustumCulled={false}
        castShadow={!lowPower}
        receiveShadow={!lowPower}
      >
        <primitive object={redSoldier} attach="geometry" />
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
  /** Who is standing, who is marching up, who is lying where. */
  state: SideState;
  side: Side;
  /** -1 being driven back, +1 driving forward. */
  advance: number;
  dummy: Object3D;
  time: number;
  intense: boolean;
}

function paintSide(a: PaintArgs): void {
  const { mesh, tracers, flashes, count, dir, baseX, frontX, table, state, side, advance, dummy, time, intense } = a;
  if (!mesh) return;

  /* ---- casualties from real detonations landing on our ground ---- */
  state.blastCursor = drainBlasts(state.blastCursor, (blast) => {
    // The side that fired is not the side that bleeds.
    if (blast.side === side) return;
    const reach = blast.radius * 1.7;
    // A bigger round takes more men down, but never guts the whole line.
    let allowance = Math.max(1, Math.round(blast.radius / 2.6));
    for (let i = 0; i < count && allowance > 0; i++) {
      if (state.slots[i].phase !== 'standing') continue;
      const dx = state.posX[i] - blast.x;
      const dz = state.posZ[i] - blast.z;
      if (dx * dx + dz * dz > reach * reach) continue;
      fell(state, i, state.posX[i], state.posZ[i], dir === -1 ? 0 : Math.PI, time);
      allowance--;
    }
  });

  /* ---- the roll call: who should be on the field right now ---- */
  for (let i = 0; i < state.slots.length; i++) {
    const slot = state.slots[i];
    const wanted = i < count;

    if (wanted && slot.phase === 'out' && time >= slot.readyAt) {
      slot.phase = 'arriving';
      slot.since = time;
    } else if (wanted && slot.phase === 'arriving' && time - slot.since >= ARRIVE_TIME) {
      slot.phase = 'standing';
      slot.since = time;
    } else if (!wanted && slot.phase !== 'out') {
      // The side's liquidity no longer supports him: he falls where he stood.
      fell(state, i, state.posX[i], state.posZ[i], dir === -1 ? 0 : Math.PI, time);
    }
  }

  let drawn = 0;

  /* ---- the dead, laid out where they fell ---- */
  for (const corpse of state.corpses) {
    if (corpse.fellAt < 0) continue;
    const age = time - corpse.fellAt;
    if (age > CORPSE_LIFE) continue;

    // Topple over the first moments, lie still, then sink out of sight.
    const topple = Math.min(1, age / FALL_TIME);
    const eased = topple * topple * (3 - 2 * topple);
    const sinking = Math.max(0, age - (CORPSE_LIFE - CORPSE_SINK)) / CORPSE_SINK;
    dummy.position.set(corpse.x, -0.05 - sinking * 1.4, corpse.z);
    dummy.rotation.set(0, corpse.yaw, eased * (Math.PI / 2) * corpse.roll);
    dummy.scale.setScalar(1.42);
    dummy.updateMatrix();
    mesh.setMatrixAt(drawn++, dummy.matrix);
  }

  if (count === 0) {
    mesh.count = drawn;
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
    const slot = state.slots[i];
    if (!c || !slot || slot.phase === 'out') continue;

    /* ---- this soldier's own post, and his own wander around it ---- */
    // Every soldier is trying to push. He works his way forward on his own
    // clock, then falls back and goes again — so the line is always straining
    // toward the enemy instead of standing still.
    const pushPhase = ((time + c.pushOffset * c.pushPeriod) % c.pushPeriod) / c.pushPeriod;
    // Slow surge over most of the cycle, quick fall-back at the end.
    const surge = pushPhase < 0.75 ? pushPhase / 0.75 : 1 - (pushPhase - 0.75) / 0.25;

    // A side that is winning presses forward and bounds: odd-numbered men rush
    // while the others hold. A side being driven back gives ground instead.
    const bounding = advance > 0 ? (i % 2 === 0 ? 1.3 : 0.55) : 1;
    const press = c.pushReach * surge * (0.45 + 0.55 * Math.max(0, advance)) * bounding;
    const giveGround = Math.max(0, -advance) * 3.2;

    const postX = frontX + dir * (3 + c.postDepth * band) - dir * press + dir * giveGround;

    // Two independent slow oscillations, each with its own rate and phase, so
    // no two soldiers ever trace the same path or share a rhythm.
    const wx = Math.sin(time * c.wanderRateX + c.wanderPhX) * c.reach;
    const wz = Math.cos(time * c.wanderRateZ + c.wanderPhZ) * c.reach;

    // Marching gait: |sin| gives two footfalls per cycle. Each soldier steps at
    // his own tempo, and the whole line quickens when the front is moving.
    const urgency = 1 + Math.abs(advance) * 0.7;
    const gait = time * gaitSpeed * c.gaitRate * urgency + c.gaitPhase;
    const lift = Math.abs(Math.sin(gait)) * gaitLift;
    const stride = Math.sin(gait) * (intense ? 0.34 : 0.2);

    // Nobody crosses the line of contact. The front line is the wall between
    // the two armies: green holds everything to its left, red everything to its
    // right, and the push above can strain against it but never through it.
    const rawX = postX + wx - dir * stride;
    let x = dir === -1 ? Math.min(rawX, frontX - 1.6) : Math.max(rawX, frontX + 1.6);
    let z = Math.max(-FIELD_HALF_Z, Math.min(FIELD_HALF_Z, c.postZ + wz));
    const scale = c.scale;

    // Reinforcements march up from their own base and fall in at the post.
    if (slot.phase === 'arriving') {
      const p = Math.min(1, (time - slot.since) / ARRIVE_TIME);
      const eased = p * p * (3 - 2 * p);
      x = baseX + (x - baseX) * eased;
      z = c.postZ * 0.25 + (z - c.postZ * 0.25) * eased;
    }

    // Remembered so a blast can work out who was standing where.
    state.posX[i] = x;
    state.posZ[i] = z;

    /* ---- ambient burst timing (cosmetic; see the file header) ---- */
    const cycle = ((time + c.fireOffset * c.fireInterval) % c.fireInterval) / c.fireInterval;
    const firing = cycle < BURST_FRACTION;
    const burstT = firing ? cycle / BURST_FRACTION : 0;

    // A firing soldier squares up to the enemy and takes the recoil; otherwise
    // he scans his sector.
    const scan = firing ? 0 : Math.sin(time * 0.45 + c.wanderPhX) * 0.22;
    const yaw = (dir === -1 ? 0 : Math.PI) + c.yawJitter + scan;
    const recoil = firing ? Math.sin(burstT * Math.PI) * 0.07 : 0;

    // Leaning into the push, or leaning back while giving ground.
    const lean = advance * 0.13;
    dummy.position.set(x, lift, z);
    dummy.rotation.set(0, yaw, Math.sin(gait * 0.5) * (intense ? 0.05 : 0.025) - recoil + lean);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(drawn++, dummy.matrix);

    // A man still marching up is not yet in the fight.
    if (!firing || slot.phase !== 'standing') continue;

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

  mesh.count = drawn;
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
