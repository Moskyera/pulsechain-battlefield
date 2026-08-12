'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, Object3D, type Group, type InstancedMesh, type Mesh, type MeshBasicMaterial } from 'three';
import { runtime } from '@/lib/sim/runtime';
import { field } from '@/lib/sim/field';
import { hashSigned, hashUnit } from '@/lib/util/hash';
import { sackNormal } from '@/lib/sim/textures';
import { COLORS, FIELD_HALF_Z, frontLineToX } from '@/lib/sim/layout';

/**
 * The line of contact, as ground rather than as light.
 *
 * It used to be a glowing beam with a bloom painted under it: unmistakable, but
 * the single most artificial object on the field, and a straight one at that.
 * Real fronts are dug, not drawn, and they are ragged. This is a works line:
 * a sandbag parapet with the bags stacked unevenly, spoil heaped behind it, and
 * a belt of wire on stakes in front, all of it jittered along its length so no
 * two sections agree.
 *
 * Its X position is still the eased front line, so exactly the same real price
 * momentum and order flow move it. Only its appearance changed. A whisper of
 * team colour stays in the wire stakes, leaning to whoever currently holds the
 * advantage, so the line still tells you who is winning at a glance.
 *
 * Three instanced meshes, three draw calls, everything else is arithmetic.
 */

/** Sections along the width of the field. */
const SECTIONS = 34;
const BAGS_PER_SECTION = 2;
const BAG_COUNT = SECTIONS * BAGS_PER_SECTION;
const STAKE_COUNT = 20;

interface Section {
  z: number;
  /** How far this section bulges ahead of or behind the mean line. */
  bulge: number;
  height: number;
  yaw: number;
  tilt: number;
}

export function FrontLine() {
  const groupRef = useRef<Group>(null);
  const bagsRef = useRef<InstancedMesh>(null);
  const spoilRef = useRef<InstancedMesh>(null);
  const stakesRef = useRef<InstancedMesh>(null);
  const glowRef = useRef<Mesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const sacking = useMemo(() => sackNormal(), []);

  /**
   * The shape of the works, hashed once. A perfectly straight parapet is the
   * thing that reads as a graphic; the bulges are what make it read as digging.
   */
  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    for (let i = 0; i < SECTIONS; i++) {
      const s = 'front' + i;
      const t = (i + 0.5) / SECTIONS;
      out.push({
        z: (t - 0.5) * 2 * FIELD_HALF_Z * 1.02,
        bulge: hashSigned(s + 'b') * 1.5 + Math.sin(t * 9.1) * 0.9,
        height: 0.42 + hashUnit(s + 'h') * 0.34,
        yaw: hashSigned(s + 'y') * 0.5,
        tilt: hashSigned(s + 't') * 0.12,
      });
    }
    return out;
  }, []);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;

    group.position.x = frontLineToX(runtime.frontLine);

    const lead = runtime.frontLine;
    const holder = lead >= 0 ? COLORS.buy : COLORS.sell;
    const pulse = 0.75 + Math.sin(runtime.elapsed * (field.intense ? 6 : 2.6)) * 0.25;

    const bags = bagsRef.current;
    if (bags) {
      let n = 0;
      for (const sec of sections) {
        for (let b = 0; b < BAGS_PER_SECTION; b++) {
          // Two courses of bags, the upper one set back and shorter.
          const upper = b === 1;
          dummy.position.set(
            sec.bulge + (upper ? -0.22 : 0),
            (upper ? sec.height * 1.5 : sec.height * 0.5) - 0.05,
            sec.z + (upper ? 0.35 : 0),
          );
          dummy.rotation.set(sec.tilt, sec.yaw + (upper ? 0.3 : 0), sec.tilt * 0.6);
          dummy.scale.set(1.15, sec.height * (upper ? 0.85 : 1), 1.5);
          dummy.updateMatrix();
          bags.setMatrixAt(n++, dummy.matrix);
        }
      }
      bags.count = n;
      bags.instanceMatrix.needsUpdate = true;
    }

    // Spoil: the earth thrown out of the cut, heaped on the friendly side.
    const spoil = spoilRef.current;
    if (spoil) {
      let n = 0;
      for (const sec of sections) {
        dummy.position.set(sec.bulge - 1.5, 0.02, sec.z + sec.yaw);
        dummy.rotation.set(0, sec.yaw * 2, 0);
        dummy.scale.set(1.6, 0.32 + sec.height * 0.3, 2.1);
        dummy.updateMatrix();
        spoil.setMatrixAt(n++, dummy.matrix);
      }
      spoil.count = n;
      spoil.instanceMatrix.needsUpdate = true;
    }

    // Wire stakes, leaning at the angle only a hammered post ever sits at.
    const stakes = stakesRef.current;
    if (stakes) {
      let n = 0;
      for (let i = 0; i < STAKE_COUNT; i++) {
        const t = (i + 0.5) / STAKE_COUNT;
        const s = 'stake' + i;
        dummy.position.set(1.6 + hashSigned(s) * 0.5, 0.55, (t - 0.5) * 2 * FIELD_HALF_Z);
        dummy.rotation.set(hashSigned(s + 'a') * 0.22, hashUnit(s + 'b') * 3, hashSigned(s + 'c') * 0.3);
        dummy.scale.set(0.09, 1.1, 0.09);
        dummy.updateMatrix();
        stakes.setMatrixAt(n++, dummy.matrix);
      }
      stakes.count = n;
      stakes.instanceMatrix.needsUpdate = true;
      const mat = stakes.material as MeshBasicMaterial;
      mat.color.set(holder);
    }

    // A low, narrow scorch of team colour in the cut itself. Nothing like the
    // old beam: it reads as the line being contested, not as a light source.
    const glowMat = glowRef.current?.material as MeshBasicMaterial | undefined;
    if (glowMat) {
      glowMat.color.set(holder);
      glowMat.opacity = (0.05 + Math.abs(lead) * 0.1) * pulse;
    }
  });

  return (
    <group ref={groupRef}>
      {/* Sandbag parapet */}
      <instancedMesh ref={bagsRef} args={[undefined, undefined, BAG_COUNT]} frustumCulled={false} castShadow receiveShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial
          color="#57503f"
          normalMap={sacking}
          normalScale={[1.1, 1.1]}
          roughness={0.98}
        />
      </instancedMesh>

      {/* Spoil heaped behind the parapet */}
      <instancedMesh ref={spoilRef} args={[undefined, undefined, SECTIONS]} frustumCulled={false} receiveShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#5d5340" roughness={1} flatShading />
      </instancedMesh>

      {/* Wire stakes out front, tinted by whoever holds the advantage */}
      <instancedMesh ref={stakesRef} args={[undefined, undefined, STAKE_COUNT]} frustumCulled={false} castShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color={COLORS.neutral} toneMapped={false} />
      </instancedMesh>

      {/* Churned, contested ground right in the cut */}
      <mesh ref={glowRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <planeGeometry args={[3.2, FIELD_HALF_Z * 2]} />
        <meshBasicMaterial
          color={COLORS.neutral}
          transparent
          opacity={0.08}
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}
