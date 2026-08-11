'use client';

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group, Mesh, MeshStandardMaterial } from 'three';
import { field } from '@/lib/sim/field';
import { runtime } from '@/lib/sim/runtime';
import { COLORS, FIELD_HALF_Z, GREEN_BASE_X, RED_BASE_X } from '@/lib/sim/layout';

/**
 * Home bases — the liquidity walls' strongholds.
 *
 * The keep's emissive intensity tracks that side's real reserve value, so a
 * pool whose quote side is being drained visibly dims. When the front line
 * reaches a base, that side is losing badly.
 */
export function Bases({ lowPower }: { lowPower: boolean }) {
  return (
    <group>
      <Base side="buy" x={GREEN_BASE_X} lowPower={lowPower} />
      <Base side="sell" x={RED_BASE_X} lowPower={lowPower} />
    </group>
  );
}

function Base({ side, x, lowPower }: { side: 'buy' | 'sell'; x: number; lowPower: boolean }) {
  const groupRef = useRef<Group>(null);
  const keepRef = useRef<Mesh>(null);
  const color = side === 'buy' ? COLORS.buy : COLORS.sell;
  const dir = side === 'buy' ? 1 : -1;

  useFrame(() => {
    const keep = keepRef.current;
    if (!keep) return;

    const mine = side === 'buy' ? field.greenStrengthUsd : field.redStrengthUsd;
    const other = side === 'buy' ? field.redStrengthUsd : field.greenStrengthUsd;
    const total = mine + other;

    // Share of total pool value held on this side. In a balanced V2 pool this
    // sits near 0.5 and drifts as one leg is bought out.
    const share = total > 0 ? mine / total : 0.5;
    const pulse = 0.85 + Math.sin(runtime.elapsed * (field.intense ? 5 : 2)) * 0.15;

    // Kept low: at full strength the keeps render as solid slabs of pure team
    // colour and pull the eye straight off the fighting.
    const mat = keep.material as MeshStandardMaterial;
    // Slightly hotter than before: with the base point light gone, the keep's
    // own emissive is what says which side this is.
    mat.emissiveIntensity = field.hasData ? (0.12 + share * 0.42) * pulse : 0.09;

    if (groupRef.current) {
      groupRef.current.position.y = Math.sin(runtime.elapsed * 0.8 + (side === 'buy' ? 0 : 1.7)) * 0.06;
    }
  });

  return (
    <group ref={groupRef} position={[x, 0, 0]}>
      {/* Keep */}
      <mesh ref={keepRef} position={[0, 3, 0]} castShadow={!lowPower}>
        <boxGeometry args={[4.5, 6, 10]} />
        <meshStandardMaterial
          color="#3d4436"
          emissive={color}
          emissiveIntensity={0.2}
          roughness={0.85}
          metalness={0.2}
        />
      </mesh>

      {/* Ramparts facing the field */}
      <mesh position={[dir * 3.6, 1.4, 0]} castShadow={!lowPower}>
        <boxGeometry args={[1.6, 2.8, 16]} />
        <meshStandardMaterial color="#111a23" roughness={0.85} metalness={0.2} />
      </mesh>

      {/* Corner towers */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[0, 3, s * FIELD_HALF_Z * 0.72]} castShadow={!lowPower}>
          <cylinderGeometry args={[1.5, 1.9, 6, lowPower ? 5 : 8]} />
          <meshStandardMaterial
            color="#16202b"
            emissive={color}
            emissiveIntensity={0.5}
            roughness={0.7}
            metalness={0.3}
          />
        </mesh>
      ))}

      {/* Banner beacon. Unlit and toneMapped={false}, so it burns team-bright
          without a point light behind it — a real light here made every
          standard material in range pay for it on every pixel. */}
      <mesh position={[0, 9.5, 0]}>
        <sphereGeometry args={[1.05, lowPower ? 6 : 10, lowPower ? 5 : 8]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
    </group>
  );
}
