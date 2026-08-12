'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Color, Object3D, type InstancedMesh } from 'three';
import { drainBlasts, runtime } from '@/lib/sim/runtime';

/**
 * What the fighting leaves behind.
 *
 * Every real detonation burns a mark into the ground where it landed, and the
 * marks stay for minutes. Before this the field was spotless a second after a
 * $20k trade went off, which made every blast feel weightless and left no trace
 * of where the war had actually been fought. Now the ground accumulates the
 * session: a quiet market keeps a clean field, a heavy hour churns the middle
 * of it black.
 *
 * Nothing here is decoration on a timer. One scar equals one real on-chain
 * trade that detonated at that spot (Combat.tsx records them).
 *
 * Cost is one draw call. A shared material cannot carry per-instance opacity,
 * so a scar fades by having its instance colour walk from burnt earth back to
 * the colour of the dirt around it: by the end it is indistinguishable from the
 * ground and blends away without ever changing the material.
 */

const SCAR_CAPACITY = 48;
/** Seconds a scar takes to blend back into the dirt. */
const SCAR_LIFE = 150;
/** Burnt earth, and the terrain tone it eventually dissolves into. */
const SCORCH = new Color('#241c14');
const DIRT = new Color('#8b7d5a');

interface Scar {
  x: number;
  z: number;
  radius: number;
  born: number;
  /** Slight rotation so a row of craters does not look stamped. */
  spin: number;
}

export function Scars({ lowPower }: { lowPower: boolean }) {
  const meshRef = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const tint = useMemo(() => new Color(), []);
  const capacity = lowPower ? 24 : SCAR_CAPACITY;

  const scars = useMemo<Scar[]>(
    () => Array.from({ length: capacity }, () => ({ x: 0, z: 0, radius: 0, born: -1, spin: 0 })),
    [capacity],
  );
  const head = useRef(0);
  const cursor = useRef(0);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const t = runtime.elapsed;

    cursor.current = drainBlasts(cursor.current, (blast) => {
      const scar = scars[head.current % capacity];
      head.current++;
      scar.x = blast.x;
      scar.z = blast.z;
      // Well inside the fireball: a crater the full width of the blast turns
      // the field into one black sheet after a busy few minutes.
      scar.radius = blast.radius * 0.55;
      scar.born = t;
      scar.spin = (head.current % 7) * 0.9;
    });

    let drawn = 0;
    for (const scar of scars) {
      if (scar.born < 0) continue;
      const age = t - scar.born;
      if (age > SCAR_LIFE) continue;

      // Punched in fast, then healing slowly for the rest of its life.
      const open = Math.min(1, age / 0.45);
      const life = 1 - age / SCAR_LIFE;

      dummy.position.set(scar.x, 0.035, scar.z);
      dummy.rotation.set(-Math.PI / 2, 0, scar.spin);
      dummy.scale.setScalar(Math.max(0.001, scar.radius * open));
      dummy.updateMatrix();
      mesh.setMatrixAt(drawn, dummy.matrix);

      // Burnt earth at first, walking back to the surrounding dirt as it heals.
      tint.copy(SCORCH).lerp(DIRT, 1 - life * life);
      mesh.setColorAt(drawn, tint);
      drawn++;
    }

    mesh.count = drawn;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, capacity]} frustumCulled={false}>
      <circleGeometry args={[1, lowPower ? 10 : 14]} />
      <meshBasicMaterial transparent opacity={0.62} depthWrite={false} />
    </instancedMesh>
  );
}
