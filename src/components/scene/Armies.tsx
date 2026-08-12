'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, Object3D, type InstancedMesh } from 'three';
import { field } from '@/lib/sim/field';
import { drainBlasts, runtime } from '@/lib/sim/runtime';
import { KIT_BUY, KIT_SELL, legGeometry, soldierGeometry } from '@/lib/sim/geometry';
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
/** Longest a reinforcement may take to reach his post before he counts as in. */
const ARRIVE_TIME = 9;

/**
 * Locomotion constants.
 *
 * A soldier holds his ground until his post has drifted further than his own
 * slack, then runs to it and stops again. That hysteresis is what produces
 * move-and-hold instead of a field of men gliding about continuously, and it
 * means a still market leaves the line genuinely still.
 */
const RUN_SPEED = 7.4;
const MARCH_SPEED = 3.1;
/** World units covered per stride. Sets the cadence against real distance. */
const STRIDE = 1.15;
/** Radians a leg swings at full running speed. */
const SWING_MAX = 0.72;
/**
 * Getting under way and pulling up.
 *
 * A man used to jump from a standstill to full speed on one frame and stop the
 * same way, which is what made the movement look like it was snapping between
 * states. He now builds speed over roughly a third of a second and eases down
 * into his post, so the same move-and-hold behaviour reads as running rather
 * than teleporting.
 */
const ACCEL = 16;
const BRAKE = 22;

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
  /** How far his post may drift before he bothers to get up and move. */
  slack: number;
  /** His own running pace, so a rush is ragged rather than a chorus line. */
  pace: number;
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
      slack: 1.4 + hashUnit(s + 'sl') * 2.4,
      pace: 0.82 + hashUnit(s + 'pc') * 0.36,
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
  /**
   * Locomotion. A soldier is not teleported onto his post every frame any more:
   * he runs to it and then stands, so his speed is something that emerges from
   * the field moving rather than a number we invent.
   */
  moving: Uint8Array;
  /** Stride phase, advanced by distance covered so the feet match the ground. */
  gait: Float32Array;
  /** Smoothed facing, so nobody snaps round on the spot. */
  yaw: Float32Array;
  /** Metres per second right now, for leg swing, lean and bob. */
  speed: Float32Array;
  /** Actual carried velocity, so nobody starts or stops on a single frame. */
  vel: Float32Array;
  /**
   * Low-passed version of the push/give-ground drive.
   *
   * The raw value is the front line's spring velocity, which crosses zero
   * constantly as the spring settles. Feeding that straight into the men's
   * posts made every target jump several metres the instant the sign flipped,
   * and the whole army juddered on the spot trying to chase it.
   */
  drive: number;
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
    moving: new Uint8Array(capacity),
    gait: new Float32Array(capacity),
    yaw: new Float32Array(capacity),
    speed: new Float32Array(capacity),
    vel: new Float32Array(capacity),
    drive: 0,
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
  const greenLegL = useRef<InstancedMesh>(null);
  const greenLegR = useRef<InstancedMesh>(null);
  const redLegL = useRef<InstancedMesh>(null);
  const redLegR = useRef<InstancedMesh>(null);
  const greenTracers = useRef<InstancedMesh>(null);
  const redTracers = useRef<InstancedMesh>(null);
  const greenFlashes = useRef<InstancedMesh>(null);
  const redFlashes = useRef<InstancedMesh>(null);

  const dummy = useMemo(() => new Object3D(), []);
  const greenSoldier = useMemo(() => soldierGeometry(KIT_BUY), []);
  const redSoldier = useMemo(() => soldierGeometry(KIT_SELL), []);
  const greenLeg = useMemo(() => legGeometry(KIT_BUY), []);
  const redLeg = useMemo(() => legGeometry(KIT_SELL), []);
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
      legsLeft: greenLegL.current,
      legsRight: greenLegR.current,
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
      dt,
      intense,
    });

    paintSide({
      mesh: redRef.current,
      legsLeft: redLegL.current,
      legsRight: redLegR.current,
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
      dt,
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
      roughness={0.78}
      metalness={0.12}
      envMapIntensity={0.35}
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

      {/* Legs. Same instance count as the bodies above them, one mesh per leg,
          so a whole army walks for two extra draw calls. */}
      <instancedMesh ref={greenLegL} args={[undefined, undefined, capacity + CORPSE_CAPACITY]} frustumCulled={false} castShadow={!lowPower}>
        <primitive object={greenLeg} attach="geometry" />
        {troopMaterial(COLORS.buy)}
      </instancedMesh>
      <instancedMesh ref={greenLegR} args={[undefined, undefined, capacity + CORPSE_CAPACITY]} frustumCulled={false} castShadow={!lowPower}>
        <primitive object={greenLeg} attach="geometry" />
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

      <instancedMesh ref={redLegL} args={[undefined, undefined, capacity + CORPSE_CAPACITY]} frustumCulled={false} castShadow={!lowPower}>
        <primitive object={redLeg} attach="geometry" />
        {troopMaterial(COLORS.sell)}
      </instancedMesh>
      <instancedMesh ref={redLegR} args={[undefined, undefined, capacity + CORPSE_CAPACITY]} frustumCulled={false} castShadow={!lowPower}>
        <primitive object={redLeg} attach="geometry" />
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
  /** Legs live in their own meshes so they can swing independently. */
  legsLeft: InstancedMesh | null;
  legsRight: InstancedMesh | null;
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
  dt: number;
  intense: boolean;
}

function paintSide(a: PaintArgs): void {
  const { mesh, legsLeft, legsRight, tracers, flashes, count, dir, baseX, frontX, table, state, side, advance, dummy, time, dt, intense } = a;
  if (!mesh) return;

  let legDrawn = 0;

  // Half a second of smoothing: enough to kill the sign-flapping around zero
  // without losing a real push.
  state.drive += (advance - state.drive) * Math.min(1, dt * 2);
  const drive = state.drive;

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

    // His legs go down with him, splayed rather than at attention.
    const hipY = -0.05 - sinking * 1.4 + 0.8 * 1.42 * (1 - eased);
    const sinYaw = Math.sin(corpse.yaw);
    const cosYaw = Math.cos(corpse.yaw);
    for (let leg = 0; leg < 2; leg++) {
      const legMesh = leg === 0 ? legsLeft : legsRight;
      if (!legMesh) continue;
      const offZ = (leg === 0 ? -0.155 : 0.155) * 1.42;
      dummy.position.set(corpse.x + sinYaw * offZ, hipY, corpse.z + cosYaw * offZ);
      dummy.rotation.set(
        0,
        corpse.yaw,
        eased * (Math.PI / 2) * corpse.roll + (leg === 0 ? 0.3 : -0.18) * eased,
      );
      dummy.scale.setScalar(1.42);
      dummy.updateMatrix();
      legMesh.setMatrixAt(legDrawn, dummy.matrix);
    }
    legDrawn++;
  }

  if (count === 0) {
    mesh.count = drawn;
    mesh.instanceMatrix.needsUpdate = true;
    commitLegs(legsLeft, legsRight, legDrawn);
    if (tracers) tracers.count = 0;
    if (flashes) flashes.count = 0;
    return;
  }

  /** Toward the enemy. `dir` points back to our own base. */
  const faceDir = -dir;
  // The army occupies the whole of its own ground, front line back to base,
  // rather than huddling in a strip behind the line.
  const band = Math.max(6, Math.abs(baseX - frontX) - 4);
  const gaitLift = intense ? 0.16 : 0.1;

  let tracerN = 0;
  let flashN = 0;

  for (let i = 0; i < count; i++) {
    const c = table[i];
    const slot = state.slots[i];
    if (!c || !slot || slot.phase === 'out') continue;

    const justArrived = slot.phase === 'arriving' && state.speed[i] === 0 && time - slot.since < 0.05;
    if (justArrived) {
      // Reinforcements step off from their own base and run in from there.
      state.posX[i] = baseX;
      state.posZ[i] = c.postZ * 0.3;
      state.yaw[i] = dir === -1 ? 0 : Math.PI;
    }

    /* ---- this soldier's own post, and his own wander around it ---- */
    // Every soldier is trying to push. He works his way forward on his own
    // clock, then falls back and goes again — so the line is always straining
    // toward the enemy instead of standing still.
    const pushPhase = ((time + c.pushOffset * c.pushPeriod) % c.pushPeriod) / c.pushPeriod;
    // Slow surge over most of the cycle, quick fall-back at the end.
    const surge = pushPhase < 0.75 ? pushPhase / 0.75 : 1 - (pushPhase - 0.75) / 0.25;

    // A side that is winning presses forward and bounds: half the men rush
    // while the others hold. A side being driven back gives ground instead.
    // Both effects scale continuously out of the drive, so as the push fades
    // the difference between bounding and not simply vanishes: it must never
    // switch, or every post on the field moves at once.
    const push = Math.max(0, drive);
    const bounding = 1 + push * (i % 2 === 0 ? 0.32 : -0.38);
    const press = c.pushReach * surge * (0.45 + 0.55 * push) * bounding;
    const giveGround = Math.max(0, -drive) * 3.2;

    const postX = frontX + dir * (3 + c.postDepth * band) - dir * press + dir * giveGround;

    // Two independent slow oscillations, each with its own rate and phase, so
    // no two soldiers ever trace the same path or share a rhythm.
    const wx = Math.sin(time * c.wanderRateX + c.wanderPhX) * c.reach;
    const wz = Math.cos(time * c.wanderRateZ + c.wanderPhZ) * c.reach;

    // Nobody crosses the line of contact. The front line is the wall between
    // the two armies: green holds everything to its left, red everything to its
    // right, and the push above can strain against it but never through it.
    const rawX = postX + wx;
    const wantX = dir === -1 ? Math.min(rawX, frontX - 1.6) : Math.max(rawX, frontX + 1.6);
    const wantZ = Math.max(-FIELD_HALF_Z, Math.min(FIELD_HALF_Z, c.postZ + wz));
    const scale = c.scale;

    /* ---- getting there on his own two feet ---- */
    let x = state.posX[i];
    let z = state.posZ[i];
    const dx = wantX - x;
    const dz = wantZ - z;
    const gap = Math.hypot(dx, dz);

    // Hysteresis: he holds his ground until his post has drifted past his own
    // slack, then runs until he is on it. Without it every man drifts every
    // frame and the whole army looks like it is on castors.
    if (state.moving[i] === 0 && gap > c.slack) state.moving[i] = 1;
    else if (state.moving[i] === 1 && gap < 0.35) state.moving[i] = 0;

    // A man coming up from the base is committed to the run whatever his slack.
    const marching = slot.phase === 'arriving';
    if (marching && gap > 0.6) state.moving[i] = 1;

    // Urgency rises smoothly with how hard the line is moving and how far out
    // of place he is, so nobody flips between a march and a sprint on a frame
    // boundary.
    const urgency = marching
      ? 1
      : Math.min(1, Math.max(Math.abs(drive) * 1.6, (gap - 2) / 6));
    const pace =
      (MARCH_SPEED + (RUN_SPEED - MARCH_SPEED) * Math.max(0, urgency)) *
      c.pace *
      (intense ? 1.15 : 1);

    // Ease down into the post rather than stopping dead on it: the fastest he
    // may still be going at this range and still pull up in time.
    const approach = Math.sqrt(Math.max(0, 2 * BRAKE * Math.max(0, gap - 0.12)));
    const wanted = state.moving[i] === 1 ? Math.min(pace, approach) : 0;

    const rate = wanted > state.vel[i] ? ACCEL : BRAKE;
    const step = rate * dt;
    state.vel[i] += Math.max(-step, Math.min(step, wanted - state.vel[i]));
    if (state.vel[i] < 0.02) state.vel[i] = 0;

    let covered = 0;
    if (state.vel[i] > 0 && gap > 0.0001) {
      covered = Math.min(gap, state.vel[i] * dt);
      x += (dx / gap) * covered;
      z += (dz / gap) * covered;
    }

    state.posX[i] = x;
    state.posZ[i] = z;

    const speedNow = dt > 0 ? covered / dt : 0;
    // Smoothed, so the legs cannot flicker between running and standing.
    state.speed[i] += (speedNow - state.speed[i]) * Math.min(1, dt * 9);
    const speed = state.speed[i];

    if (marching && gap < 1.2) {
      slot.phase = 'standing';
      slot.since = time;
    }

    // Stride phase advances with GROUND COVERED rather than with the clock, so
    // the cadence always matches the speed and the feet stop when he stops.
    state.gait[i] = (state.gait[i] + (covered / (STRIDE * scale)) * Math.PI) % (Math.PI * 2);
    const gait = state.gait[i];
    const moveMix = Math.min(1, speed / RUN_SPEED);
    const lift = Math.abs(Math.sin(gait)) * gaitLift * (0.35 + moveMix);

    /* ---- ambient burst timing (cosmetic; see the file header) ---- */
    const cycle = ((time + c.fireOffset * c.fireInterval) % c.fireInterval) / c.fireInterval;
    // Nobody fires on the run.
    const firing = cycle < BURST_FRACTION && speed < 1.2 && slot.phase === 'standing';
    const burstT = firing ? cycle / BURST_FRACTION : 0;

    // Facing: he runs where he is going and fights where the enemy is, easing
    // between the two instead of snapping round on the spot.
    const enemyYaw = (dir === -1 ? 0 : Math.PI) + c.yawJitter;
    const scan = firing ? 0 : Math.sin(time * 0.45 + c.wanderPhX) * 0.22;
    let wantYaw = enemyYaw + scan;
    if (speed > 1.4 && gap > 0.0001) {
      wantYaw = Math.atan2(-dz / gap, dx / gap);
    }
    let turn = wantYaw - state.yaw[i];
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    state.yaw[i] += turn * Math.min(1, dt * 7);
    const yaw = state.yaw[i];

    const recoil = firing ? Math.sin(burstT * Math.PI) * 0.07 : 0;

    // Leaning into the run, and into the push or away from it while holding.
    const lean = moveMix * 0.22 + (1 - moveMix) * drive * 0.13;
    dummy.position.set(x, lift, z);
    dummy.rotation.set(0, yaw, Math.sin(gait) * 0.03 - recoil + lean);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(drawn++, dummy.matrix);

    /* ---- legs, hinged at the hip and swinging opposite each other ---- */
    const swing = Math.sin(gait) * SWING_MAX * (0.1 + moveMix * 0.9);
    const hipY = lift + 0.8 * scale;
    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    for (let leg = 0; leg < 2; leg++) {
      const legMesh = leg === 0 ? legsLeft : legsRight;
      if (!legMesh) continue;
      const offZ = (leg === 0 ? -0.155 : 0.155) * scale;
      dummy.position.set(x + sinYaw * offZ, hipY, z + cosYaw * offZ);
      dummy.rotation.set(0, yaw, leg === 0 ? swing : -swing);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      legMesh.setMatrixAt(legDrawn, dummy.matrix);
    }
    legDrawn++;

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
  commitLegs(legsLeft, legsRight, legDrawn);
  if (tracers) {
    tracers.count = tracerN;
    tracers.instanceMatrix.needsUpdate = true;
  }
  if (flashes) {
    flashes.count = flashN;
    flashes.instanceMatrix.needsUpdate = true;
  }
}

function commitLegs(left: InstancedMesh | null, right: InstancedMesh | null, count: number): void {
  for (const mesh of [left, right]) {
    if (!mesh) continue;
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
  }
}
