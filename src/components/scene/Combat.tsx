'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, Color, Object3D, Vector3, type InstancedMesh } from 'three';
import { field, swapQueue } from '@/lib/sim/field';
import { recordBlast, runtime } from '@/lib/sim/runtime';
import { TIER_PROFILE, type ImpactEvent } from '@/lib/sim/combat';
import { rocketGeometry, tracerGeometry } from '@/lib/sim/geometry';
import { audio } from '@/lib/audio/engine';
import { COLORS } from '@/lib/sim/layout';

/**
 * Ordnance in flight, and what it does when it lands.
 *
 * This component owns the frame loop for combat: it drains real swaps off the
 * queue, launches them, advances the ballistic pools, and writes the instance
 * matrices.
 *
 * What a trade looks like is decided entirely by its real USD size:
 *   infantry  a rifle tracer from the infantry line
 *   tank+     a rocket from one of the guns already standing in the battery
 *
 * The armour itself is rendered by Emplacements, not here. This loop only
 * reports which piece fired (`combat.firedPiece`) so that gun can recoil.
 *
 * Green and red get separate instanced meshes so each side can carry its own
 * emissive material without a per-instance colour lookup. Explosions fade via
 * instance colour under additive blending — a shared material can't carry
 * per-instance opacity, but brightness reads identically when blending is
 * additive.
 */

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function Combat({ lowPower }: { lowPower: boolean }) {
  const buyTracers = useRef<InstancedMesh>(null);
  const sellTracers = useRef<InstancedMesh>(null);
  const buyRockets = useRef<InstancedMesh>(null);
  const sellRockets = useRef<InstancedMesh>(null);
  const buyExhaust = useRef<InstancedMesh>(null);
  const sellExhaust = useRef<InstancedMesh>(null);
  const buyBlasts = useRef<InstancedMesh>(null);
  const sellBlasts = useRef<InstancedMesh>(null);
  const buyRings = useRef<InstancedMesh>(null);
  const sellRings = useRef<InstancedMesh>(null);
  const smoke = useRef<InstancedMesh>(null);

  const dummy = useMemo(() => new Object3D(), []);
  const cur = useMemo(() => new Vector3(), []);
  const ahead = useMemo(() => new Vector3(), []);
  /** Reused for the exhaust plume's position — cloning here allocated a vector
      per rocket per frame, straight into the garbage collector. */
  const back = useMemo(() => new Vector3(), []);
  const scratch = useMemo(() => ({ x: 0, y: 0, z: 0 }), []);
  const impacts = useMemo<ImpactEvent[]>(() => [], []);
  const tint = useMemo(() => new Color(), []);

  const rocket = useMemo(() => rocketGeometry(), []);
  const tracer = useMemo(() => tracerGeometry(), []);

  const projCap = lowPower ? 60 : 240;
  const blastCap = lowPower ? 26 : 100;
  const maxSpawnPerFrame = lowPower ? 3 : 8;

  useFrame((_, rawDelta) => {
    const dt = Math.min(rawDelta, 0.05);
    const combat = runtime.combat;

    /* -- 1. Launch newly observed real trades -------------------------- */
    const batch = swapQueue.drain(maxSpawnPerFrame);
    for (const swap of batch) {
      if (combat.spawn(swap, runtime.frontLine)) {
        runtime.spawned++;
        // The combat system reports which standing gun took the shot; stamp it
        // so that one piece recoils rather than the whole line.
        const fired = combat.firedPiece;
        if (fired) {
          runtime.batteryFire[fired.side][fired.index] = runtime.elapsed;
          combat.firedPiece = null;
        }
        if (swap.tier === 'nuke') audio.incoming();
      }
    }

    /* -- 2. Ease the front line toward its data-driven target ---------- */
    const target = clamp(field.frontLineTarget + field.impulse, -1, 1);
    field.impulse *= Math.exp(-dt * 1.3);
    if (Math.abs(field.impulse) < 1e-4) field.impulse = 0;

    const stiffness = 2.4;
    const damping = 2 * Math.sqrt(stiffness);
    runtime.frontLineVelocity +=
      (target - runtime.frontLine) * stiffness * dt - runtime.frontLineVelocity * damping * dt;
    runtime.frontLine = clamp(runtime.frontLine + runtime.frontLineVelocity * dt, -1, 1);

    /* -- 3. Advance the pools ------------------------------------------ */
    combat.shake += field.shake;
    field.shake = 0;
    combat.update(dt, impacts);

    for (const impact of impacts) {
      audio.impact(impact.tier, 0.55 + Math.min(1, impact.usd / 25_000));
      // Hand the detonation to whoever outlives the fireball: the infantry it
      // catches, and the ground it scars.
      recordBlast(impact.x, impact.z, impact.radius, impact.side);
    }

    /* -- 4. Projectiles: tracers for infantry, rockets for the rest ---- */
    let buyTracerN = 0;
    let sellTracerN = 0;
    let buyRocketN = 0;
    let sellRocketN = 0;
    let buyExhaustN = 0;
    let sellExhaustN = 0;

    for (const p of combat.projectiles) {
      if (!p.active) continue;
      const isBuy = p.side === 'buy';
      const isTracer = p.tier === 'infantry';

      combat.positionOf(p, scratch);
      cur.set(scratch.x, scratch.y, scratch.z);

      // Sample slightly ahead so the round can be aimed along its heading.
      const savedT = p.t;
      p.t = Math.min(1, p.t + 0.03);
      combat.positionOf(p, scratch);
      ahead.set(scratch.x, scratch.y, scratch.z);
      p.t = savedT;

      dummy.position.copy(cur);
      dummy.lookAt(ahead);

      if (isTracer) {
        const mesh = isBuy ? buyTracers.current : sellTracers.current;
        const idx = isBuy ? buyTracerN : sellTracerN;
        if (!mesh || idx >= projCap) continue;
        // A bead stretched along its flight path reads as a tracer round.
        dummy.scale.set(p.size, p.size, p.size * 3.4);
        dummy.updateMatrix();
        mesh.setMatrixAt(idx, dummy.matrix);
        if (isBuy) buyTracerN++;
        else sellTracerN++;

        // Muzzle flash: a bright bloom at the firing point, gone in a blink.
        if (p.t < 0.16) {
          const flashMesh = isBuy ? buyExhaust.current : sellExhaust.current;
          const fIdx = isBuy ? buyExhaustN : sellExhaustN;
          if (flashMesh && fIdx < projCap) {
            const decay = 1 - p.t / 0.16;
            dummy.position.set(p.sx, p.sy, p.sz);
            dummy.rotation.set(0, 0, 0);
            dummy.scale.setScalar(0.85 * decay);
            dummy.updateMatrix();
            flashMesh.setMatrixAt(fIdx, dummy.matrix);
            tint.set('#fff2c4').multiplyScalar(decay);
            flashMesh.setColorAt(fIdx, tint);
            if (isBuy) buyExhaustN++;
            else sellExhaustN++;
          }
        }
      } else {
        const mesh = isBuy ? buyRockets.current : sellRockets.current;
        const idx = isBuy ? buyRocketN : sellRocketN;
        if (!mesh || idx >= projCap) continue;
        dummy.scale.setScalar(p.size);
        dummy.updateMatrix();
        mesh.setMatrixAt(idx, dummy.matrix);
        if (isBuy) buyRocketN++;
        else sellRocketN++;

        const exhaustMesh = isBuy ? buyExhaust.current : sellExhaust.current;

        // Muzzle blast at the gun that fired. Without this the shot has no
        // visible moment of departure — the round simply appears mid-air and
        // the standing battery looks inert even though it is doing the firing.
        if (p.t < 0.3) {
          const eIdx = isBuy ? buyExhaustN : sellExhaustN;
          if (exhaustMesh && eIdx < projCap) {
            const punch = 1 - p.t / 0.3;
            dummy.position.set(p.sx, p.sy, p.sz);
            dummy.rotation.set(0, 0, 0);
            // Scales with the calibre, so a nuke launch is a real event.
            dummy.scale.setScalar(p.size * 2.4 * punch);
            dummy.updateMatrix();
            exhaustMesh.setMatrixAt(eIdx, dummy.matrix);
            tint.set('#fff4cc').multiplyScalar(punch);
            exhaustMesh.setColorAt(eIdx, tint);
            if (isBuy) buyExhaustN++;
            else sellExhaustN++;
          }
        }

        // Exhaust plume trailing the motor, fading as the rocket climbs away.
        const eIdx2 = isBuy ? buyExhaustN : sellExhaustN;
        if (exhaustMesh && eIdx2 < projCap) {
          back.copy(cur).lerp(ahead, -0.6);
          dummy.position.copy(back);
          dummy.rotation.set(0, 0, 0);
          const puff = p.size * (0.55 + Math.sin(p.t * 30) * 0.12);
          dummy.scale.setScalar(puff);
          dummy.updateMatrix();
          exhaustMesh.setMatrixAt(eIdx2, dummy.matrix);
          tint.set(isBuy ? COLORS.buy : COLORS.sell).multiplyScalar(0.7 * (1 - p.t * 0.5));
          exhaustMesh.setColorAt(eIdx2, tint);
          if (isBuy) buyExhaustN++;
          else sellExhaustN++;
        }
      }
    }

    commit(buyTracers.current, buyTracerN);
    commit(sellTracers.current, sellTracerN);
    commit(buyRockets.current, buyRocketN);
    commit(sellRockets.current, sellRocketN);
    commitColored(buyExhaust.current, buyExhaustN);
    commitColored(sellExhaust.current, sellExhaustN);


    /* -- 6. Explosions -------------------------------------------------- */
    let buyB = 0;
    let sellB = 0;
    let smokeIdx = 0;
    for (const e of combat.explosions) {
      if (!e.active) continue;
      const isBuy = e.side === 'buy';
      const blastMesh = isBuy ? buyBlasts.current : sellBlasts.current;
      const ringMesh = isBuy ? buyRings.current : sellRings.current;
      const idx = isBuy ? buyB : sellB;
      if (!blastMesh || idx >= blastCap) continue;

      // Fast expand, slow fade — the shape of a real blast.
      const grow = 0.25 + 0.75 * Math.sqrt(e.t);
      const fade = Math.pow(1 - e.t, 1.6);

      dummy.position.set(e.x, e.y + e.radius * 0.35 * grow, e.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(Math.max(0.001, e.radius * grow * 0.55));
      dummy.updateMatrix();
      blastMesh.setMatrixAt(idx, dummy.matrix);
      tint.set(isBuy ? COLORS.buy : COLORS.sell).multiplyScalar(fade);
      blastMesh.setColorAt(idx, tint);

      if (ringMesh) {
        const ringScale = Math.max(0.001, e.radius * (0.4 + 1.5 * e.t));
        dummy.position.set(e.x, 0.06, e.z);
        dummy.rotation.set(-Math.PI / 2, 0, 0);
        dummy.scale.set(ringScale, ringScale, 1);
        dummy.updateMatrix();
        ringMesh.setMatrixAt(idx, dummy.matrix);
        tint.set(isBuy ? COLORS.buy : COLORS.sell).multiplyScalar(fade * 0.85);
        ringMesh.setColorAt(idx, tint);
      }

      // Smoke: a dark column that climbs and spreads after the fireball has
      // gone. Opacity can't vary per instance on a shared material, so it
      // grows then shrinks away instead of fading — which reads the same.
      const smokeMesh = smoke.current;
      if (smokeMesh && smokeIdx < blastCap * 2) {
        const puff = e.t < 0.15 ? e.t / 0.15 : Math.max(0, 1 - (e.t - 0.15) / 0.85);
        dummy.position.set(e.x, e.y + e.radius * (0.5 + e.t * 1.6), e.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(Math.max(0.001, e.radius * 0.5 * puff * (0.6 + e.t)));
        dummy.updateMatrix();
        smokeMesh.setMatrixAt(smokeIdx, dummy.matrix);
        smokeIdx++;
      }

      if (isBuy) buyB++;
      else sellB++;
    }
    commit(smoke.current, smokeIdx);
    commitColored(buyBlasts.current, buyB);
    commitColored(sellBlasts.current, sellB);
    commitColored(buyRings.current, buyB);
    commitColored(sellRings.current, sellB);
  });

  // Fireballs are additive blobs, not modelled surfaces: a hundred of them at
  // 14×12 segments was ~30k triangles a frame during a busy minute, and nobody
  // could tell them from 10×8.
  const blastGeometry = <sphereGeometry args={[1, lowPower ? 7 : 10, lowPower ? 5 : 8]} />;

  return (
    <group>
      {/* Rifle tracers — trades under $500 */}
      <instancedMesh ref={buyTracers} args={[undefined, undefined, projCap]} frustumCulled={false}>
        <primitive object={tracer} attach="geometry" />
        <meshBasicMaterial color={COLORS.buy} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={sellTracers} args={[undefined, undefined, projCap]} frustumCulled={false}>
        <primitive object={tracer} attach="geometry" />
        <meshBasicMaterial color={COLORS.sell} toneMapped={false} />
      </instancedMesh>

      {/* Rockets — every trade of $500 and up, scaled by tier */}
      <instancedMesh ref={buyRockets} args={[undefined, undefined, projCap]} frustumCulled={false}>
        <primitive object={rocket} attach="geometry" />
        <meshStandardMaterial
          color="#dfe9f2"
          emissive={COLORS.buy}
          emissiveIntensity={0.5}
          roughness={0.4}
          metalness={0.5}
        />
      </instancedMesh>
      <instancedMesh ref={sellRockets} args={[undefined, undefined, projCap]} frustumCulled={false}>
        <primitive object={rocket} attach="geometry" />
        <meshStandardMaterial
          color="#f2e2e2"
          emissive={COLORS.sell}
          emissiveIntensity={0.5}
          roughness={0.4}
          metalness={0.5}
        />
      </instancedMesh>

      {/* Motor exhaust */}
      <instancedMesh ref={buyExhaust} args={[undefined, undefined, projCap]} frustumCulled={false}>
        {blastGeometry}
        <meshBasicMaterial
          transparent
          opacity={0.7}
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </instancedMesh>
      <instancedMesh ref={sellExhaust} args={[undefined, undefined, projCap]} frustumCulled={false}>
        {blastGeometry}
        <meshBasicMaterial
          transparent
          opacity={0.7}
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </instancedMesh>

      {/* Armour lives in Emplacements — the standing gun line fires these
          rounds, so nothing is spawned here. */}

      {/* Fireballs */}
      <instancedMesh ref={buyBlasts} args={[undefined, undefined, blastCap]} frustumCulled={false}>
        {blastGeometry}
        <meshBasicMaterial
          transparent
          opacity={0.85}
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </instancedMesh>
      <instancedMesh ref={sellBlasts} args={[undefined, undefined, blastCap]} frustumCulled={false}>
        {blastGeometry}
        <meshBasicMaterial
          transparent
          opacity={0.85}
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </instancedMesh>

      {/* Smoke — shared by both sides; smoke has no team. */}
      <instancedMesh ref={smoke} args={[undefined, undefined, blastCap * 2]} frustumCulled={false}>
        <sphereGeometry args={[1, lowPower ? 6 : 8, lowPower ? 5 : 6]} />
        <meshStandardMaterial
          color="#2b2f33"
          transparent
          opacity={0.42}
          depthWrite={false}
          roughness={1}
          metalness={0}
        />
      </instancedMesh>

      {/* Ground shockwaves */}
      <instancedMesh ref={buyRings} args={[undefined, undefined, blastCap]} frustumCulled={false}>
        <ringGeometry args={[0.82, 1, lowPower ? 14 : 22]} />
        <meshBasicMaterial
          transparent
          opacity={0.9}
          blending={AdditiveBlending}
          depthWrite={false}
          side={2}
          toneMapped={false}
        />
      </instancedMesh>
      <instancedMesh ref={sellRings} args={[undefined, undefined, blastCap]} frustumCulled={false}>
        <ringGeometry args={[0.82, 1, lowPower ? 14 : 22]} />
        <meshBasicMaterial
          transparent
          opacity={0.9}
          blending={AdditiveBlending}
          depthWrite={false}
          side={2}
          toneMapped={false}
        />
      </instancedMesh>
    </group>
  );
}

function commit(mesh: InstancedMesh | null, count: number): void {
  if (!mesh) return;
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
}

function commitColored(mesh: InstancedMesh | null, count: number): void {
  if (!mesh) return;
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

/** Re-exported so the HUD can label tiers with the same numbers the sim uses. */
export { TIER_PROFILE };
