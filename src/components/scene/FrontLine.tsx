'use client';

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, type Group, type Mesh, type MeshBasicMaterial } from 'three';
import { runtime } from '@/lib/sim/runtime';
import { field } from '@/lib/sim/field';
import { COLORS, FIELD_HALF_Z, frontLineToX } from '@/lib/sim/layout';

/**
 * The contested line itself.
 *
 * Its X position is the eased front line — real price momentum blended with
 * real order flow. Its colour leans toward whichever side currently holds the
 * advantage, and it pulses harder the further from centre the battle has moved.
 */
export function FrontLine() {
  const groupRef = useRef<Group>(null);
  const beamRef = useRef<Mesh>(null);
  const glowRef = useRef<Mesh>(null);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;

    const x = frontLineToX(runtime.frontLine);
    group.position.x = x;

    const lead = runtime.frontLine;
    const pulse = 0.75 + Math.sin(runtime.elapsed * (field.intense ? 6 : 2.6)) * 0.25;

    const beamMat = beamRef.current?.material as MeshBasicMaterial | undefined;
    if (beamMat) {
      beamMat.color.set(lead >= 0 ? COLORS.buy : COLORS.sell);
      beamMat.opacity = 0.45 + Math.abs(lead) * 0.3 * pulse;
    }

    const glowMat = glowRef.current?.material as MeshBasicMaterial | undefined;
    if (glowMat) {
      glowMat.color.set(lead >= 0 ? COLORS.buy : COLORS.sell);
      glowMat.opacity = (0.12 + Math.abs(lead) * 0.16) * pulse;
    }
  });

  return (
    <group ref={groupRef}>
      {/* Line of contact. Kept low and thin — it marks a position, it isn't
          meant to be the brightest thing on the field. */}
      <mesh ref={beamRef} position={[0, 1.1, 0]}>
        <boxGeometry args={[0.22, 2.2, FIELD_HALF_Z * 2]} />
        <meshBasicMaterial
          color={COLORS.neutral}
          transparent
          opacity={0.4}
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* Ground bloom either side of the line. */}
      <mesh ref={glowRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}>
        <planeGeometry args={[6, FIELD_HALF_Z * 2]} />
        <meshBasicMaterial
          color={COLORS.neutral}
          transparent
          opacity={0.15}
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* Trench markers, so the line reads as a position and not just a light. */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[0, 0.3, s * FIELD_HALF_Z * 0.94]} castShadow>
          <boxGeometry args={[1.1, 0.6, 1.1]} />
          <meshStandardMaterial color="#2b3a48" roughness={0.85} />
        </mesh>
      ))}
    </group>
  );
}
