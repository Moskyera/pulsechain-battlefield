'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  BoxGeometry,
  BufferAttribute,
  Color,
  EdgesGeometry,
  PlaneGeometry,
  type Mesh,
} from 'three';
import { runtime } from '@/lib/sim/runtime';
import { COLORS, FIELD_HALF_X, FIELD_HALF_Z, frontLineToX } from '@/lib/sim/layout';
import { groundTexture } from '@/lib/sim/textures';

/**
 * The ground, and the territory each side currently holds.
 *
 * The terrain is a single displaced, vertex-coloured mesh rather than a flat
 * slab: dirt mottled with dry grass and sand, worn tracks running the length of
 * the valley, and gentle undulation in the surrounding land.
 *
 * The playing area itself stays perfectly flat — troops and vehicles are placed
 * at y=0, so any bumps under them would leave units floating or sunk. The
 * displacement is therefore masked to zero inside the field and ramps up only
 * once you're past the fighting.
 *
 * The two tinted planes resize every frame from the eased front line, so the
 * map itself shows who is winning.
 */
export function Terrain({ lowPower }: { lowPower: boolean }) {
  const greenRef = useRef<Mesh>(null);
  const redRef = useRef<Mesh>(null);

  const boundary = useMemo(
    () => new EdgesGeometry(new BoxGeometry(FIELD_HALF_X * 2, 0.02, FIELD_HALF_Z * 2)),
    [],
  );
  const dirt = useMemo(() => groundTexture(lowPower ? 60 : 110), [lowPower]);

  /** Mottled, gently displaced terrain. Built once. */
  const ground = useMemo(() => {
    const segs = lowPower ? 90 : 170;
    const g = new PlaneGeometry(560, 460, segs, Math.round(segs * 0.8));
    g.rotateX(-Math.PI / 2);

    const pos = g.attributes.position;
    const colors = new Float32Array(pos.count * 3);

    const dirt = new Color('#8b7d5a');
    const dirtDark = new Color('#6d6244');
    const grass = new Color('#6a7345');
    const sand = new Color('#b0a17c');
    const track = new Color('#7a6d4e');
    const c = new Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);

      // Layered sines stand in for noise — deterministic, and cheap enough to
      // run over ~25k vertices at load.
      const n1 = Math.sin(x * 0.075) * Math.cos(z * 0.092);
      const n2 = Math.sin(x * 0.021 + 1.7) * Math.cos(z * 0.017 - 0.6);
      const n3 = Math.sin(x * 0.31 + 0.4) * Math.cos(z * 0.27 + 1.1);

      // Flat inside the field, rising once clear of it.
      const outX = Math.max(0, Math.abs(x) - FIELD_HALF_X - 4);
      const outZ = Math.max(0, Math.abs(z) - FIELD_HALF_Z - 4);
      const away = Math.min(1, Math.hypot(outX, outZ) / 55);
      const mask = away * away;
      pos.setY(i, (n2 * 5.5 + n1 * 1.6 + n3 * 0.35) * mask);

      // Ground cover: dry grass where it's damp, sand on the high patches.
      const wet = n2 * 0.5 + 0.5;
      c.copy(dirt).lerp(grass, Math.min(1, Math.max(0, wet * 1.15 - 0.15)));
      if (n1 > 0.45) c.lerp(sand, (n1 - 0.45) * 1.5);
      if (n3 < -0.6) c.lerp(dirtDark, 0.5);

      // Two worn vehicle tracks running the length of the valley.
      const lane = Math.min(Math.abs(z - 9.5), Math.abs(z + 12.5));
      if (lane < 1.5) c.lerp(track, 1 - lane / 1.5);

      // Churned, scorched earth along the middle where the fighting happens.
      if (Math.abs(z) < FIELD_HALF_Z && Math.abs(x) < FIELD_HALF_X) {
        c.lerp(dirtDark, 0.35 + n3 * 0.12);
      }

      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    g.setAttribute('color', new BufferAttribute(colors, 3));
    g.computeVertexNormals();
    return g;
  }, [lowPower]);

  useFrame(() => {
    const frontX = frontLineToX(runtime.frontLine);
    const left = -FIELD_HALF_X;
    const right = FIELD_HALF_X;

    const green = greenRef.current;
    if (green) {
      const width = Math.max(0.1, frontX - left);
      green.scale.x = width;
      green.position.x = left + width / 2;
    }

    const red = redRef.current;
    if (red) {
      const width = Math.max(0.1, right - frontX);
      red.scale.x = width;
      red.position.x = frontX + width / 2;
    }
  });

  return (
    <group>
      <mesh geometry={ground} position={[0, -0.02, 0]} receiveShadow={!lowPower}>
        {/* Vertex colours carry the large-scale terrain; the tiled detail map
            supplies gravel and scuff so it holds up at close zoom. */}
        <meshStandardMaterial vertexColors map={dirt} roughness={1} metalness={0} />
      </mesh>

      {/* Held territory. Unit-width planes scaled on X each frame. */}
      <mesh ref={greenRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <planeGeometry args={[1, FIELD_HALF_Z * 2]} />
        <meshBasicMaterial color={COLORS.buy} transparent opacity={0.2} depthWrite={false} />
      </mesh>
      <mesh ref={redRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <planeGeometry args={[1, FIELD_HALF_Z * 2]} />
        <meshBasicMaterial color={COLORS.sell} transparent opacity={0.2} depthWrite={false} />
      </mesh>

      {/* Field boundary. */}
      <lineSegments geometry={boundary} position={[0, 0.05, 0]}>
        <lineBasicMaterial color="#6d6549" transparent opacity={0.35} />
      </lineSegments>
    </group>
  );
}
