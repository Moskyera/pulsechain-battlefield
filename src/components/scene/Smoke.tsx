'use client';

import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Color, Object3D, type InstancedMesh } from 'three';
import { drainBlasts, runtime } from '@/lib/sim/runtime';
import { puffTexture } from '@/lib/sim/textures';
import { hashSigned, hashUnit } from '@/lib/util/hash';

/**
 * Smoke.
 *
 * The old smoke was one opaque sphere per explosion, which is the most obvious
 * trick left on the field: a ball of grey that grows and vanishes reads as a
 * ball of grey. This is the standard substitute for real volumetrics, which no
 * browser is going to afford us: a handful of soft billboards per blast, each
 * with its own size, drift, spin and lifetime, always turned to face the
 * camera. Overlapping puffs at different depths build something with volume
 * without any of the cost of volume.
 *
 * They outlive the fireball on purpose. A shell burst leaves smoke hanging for
 * a long time after the flash is gone, and reading the field a few seconds
 * later and seeing where the heavy trades landed is worth more than a tidy
 * scene. They are fed from the same blast ring buffer the ground scars use, so
 * one puff always belongs to one real detonation.
 *
 * A shared material cannot carry per-instance opacity, so a puff dissipates by
 * having its instance colour walk to the colour of the haze behind it, the same
 * trick the scars use for fading into the dirt.
 */

const PUFFS_PER_BLAST = 4;
const CAPACITY = 96;
const LIFE_MIN = 5;
const LIFE_SPAN = 4;

interface Puff {
  x: number;
  y: number;
  z: number;
  /** Drift, in world units per second. */
  vx: number;
  vy: number;
  vz: number;
  born: number;
  life: number;
  size: number;
  grow: number;
  spin: number;
  /** How dark this puff starts: fresh bursts are sootier. */
  soot: number;
}

/** The haze it dissolves into. Matches the scene fog. */
const HAZE = new Color('#c6bca6');
const SOOT = new Color('#2a2622');

export function Smoke({ lowPower }: { lowPower: boolean }) {
  const meshRef = useRef<InstancedMesh>(null);
  const camera = useThree((s) => s.camera);
  const dummy = useMemo(() => new Object3D(), []);
  const tint = useMemo(() => new Color(), []);
  const texture = useMemo(() => puffTexture(), []);

  const capacity = lowPower ? 40 : CAPACITY;
  const perBlast = lowPower ? 2 : PUFFS_PER_BLAST;

  const puffs = useMemo<Puff[]>(
    () =>
      Array.from({ length: capacity }, () => ({
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        born: -1, life: 1, size: 1, grow: 1, spin: 0, soot: 1,
      })),
    [capacity],
  );
  const head = useRef(0);
  const cursor = useRef(0);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const t = runtime.elapsed;

    cursor.current = drainBlasts(cursor.current, (blast) => {
      // A bigger round throws more of it, and throws it further.
      const spread = blast.radius * 0.45;
      for (let i = 0; i < perBlast; i++) {
        const s = 'puff' + head.current + ':' + i;
        const puff = puffs[head.current % capacity];
        head.current++;

        puff.x = blast.x + hashSigned(s + 'x') * spread;
        puff.y = 0.6 + hashUnit(s + 'y') * blast.radius * 0.5;
        puff.z = blast.z + hashSigned(s + 'z') * spread;
        // Thrown out and up, then it just drifts.
        puff.vx = hashSigned(s + 'u') * 0.9;
        puff.vy = 0.5 + hashUnit(s + 'v') * 1.1;
        puff.vz = hashSigned(s + 'w') * 0.9;
        puff.born = t;
        puff.life = LIFE_MIN + hashUnit(s + 'l') * LIFE_SPAN;
        puff.size = blast.radius * (0.5 + hashUnit(s + 's') * 0.5);
        puff.grow = 1.4 + hashUnit(s + 'g') * 1.8;
        puff.spin = hashSigned(s + 'r') * 1.4;
        puff.soot = 0.55 + hashUnit(s + 'k') * 0.45;
      }
    });

    let drawn = 0;
    for (const puff of puffs) {
      if (puff.born < 0) continue;
      const age = t - puff.born;
      if (age > puff.life) continue;
      const p = age / puff.life;

      // Rises and spreads while it cools, slowing as it goes.
      const drag = 1 - Math.exp(-age * 0.55);
      const scale = puff.size * (1 + puff.grow * p);

      dummy.position.set(
        puff.x + puff.vx * drag * 3.2,
        puff.y + puff.vy * drag * 3.6,
        puff.z + puff.vz * drag * 3.2,
      );
      // Face the camera, then roll, so each puff turns at its own rate.
      dummy.quaternion.copy(camera.quaternion);
      dummy.rotateZ(puff.spin * age * 0.35);
      dummy.scale.setScalar(Math.max(0.001, scale));
      dummy.updateMatrix();
      mesh.setMatrixAt(drawn, dummy.matrix);

      // Sooty at first, then thinning into the haze until it is gone.
      tint.copy(SOOT).lerp(HAZE, Math.min(1, 0.15 + p * 1.05));
      tint.lerp(HAZE, 1 - puff.soot);
      mesh.setColorAt(drawn, tint);
      drawn++;
    }

    mesh.count = drawn;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, capacity]} frustumCulled={false}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial
        map={texture ?? undefined}
        transparent
        opacity={0.5}
        depthWrite={false}
        toneMapped={false}
      />
    </instancedMesh>
  );
}
