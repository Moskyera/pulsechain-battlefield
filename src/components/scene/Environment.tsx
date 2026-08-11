'use client';

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  BackSide,
  BoxGeometry,
  BufferAttribute,
  Color,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  type BufferGeometry,
  type InstancedMesh,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hashUnit, hashUnitSalted, hashSigned } from '@/lib/util/hash';
import { runtime } from '@/lib/sim/runtime';
import { FIELD_HALF_X, FIELD_HALF_Z } from '@/lib/sim/layout';

/**
 * Scenery.
 *
 * The battlefield sits in a valley rather than on an empty plane: ridgelines on
 * the horizon, tree lines and rocks flanking the field, a scatter of buildings
 * behind each side, and slow smoke columns drifting up from the hills.
 *
 * None of this is data - it is set dressing, and it is deliberately placed
 * *outside* the playing area so it never obscures a real trade. Every position
 * is hashed from its index, so the valley is identical on every load rather
 * than reshuffling itself.
 *
 * Everything here is instanced and built from merged primitives: the whole
 * environment is a handful of draw calls.
 */

function paint(geo: BufferGeometry, hex: string): BufferGeometry {
  const c = new Color(hex);
  const n = geo.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new BufferAttribute(colors, 3));
  return geo;
}

function merged(parts: BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!g) throw new Error('scenery merge failed');
  g.computeVertexNormals();
  return g;
}

/** A palm: bare trunk with a crown of drooping fronds. */
function palmGeometry(): BufferGeometry {
  const trunk = new CylinderGeometry(0.16, 0.26, 6.5, 6);
  trunk.translate(0, 3.25, 0);

  const fronds: BufferGeometry[] = [];
  for (let i = 0; i < 7; i++) {
    const f = new BoxGeometry(2.9, 0.09, 0.5);
    f.translate(1.45, 0, 0);
    f.rotateZ(-0.42);
    f.rotateY((i / 7) * Math.PI * 2);
    f.translate(0, 6.5, 0);
    fronds.push(paint(f, i % 2 === 0 ? '#41632f' : '#4e7238'));
  }
  return merged([paint(trunk, '#5b4632'), ...fronds]);
}

/** A conifer, for the hillsides. */
function pineGeometry(): BufferGeometry {
  const trunk = new CylinderGeometry(0.14, 0.2, 1.6, 5);
  trunk.translate(0, 0.8, 0);
  const parts: BufferGeometry[] = [paint(trunk, '#4a3a2a')];
  for (let i = 0; i < 3; i++) {
    const c = new ConeGeometry(1.5 - i * 0.35, 2.2, 7);
    c.translate(0, 1.9 + i * 1.25, 0);
    parts.push(paint(c, i === 0 ? '#2e4a28' : '#375a2f'));
  }
  return merged(parts);
}

/** A low suburban block with a pitched roof. */
function buildingGeometry(): BufferGeometry {
  const walls = new BoxGeometry(5.4, 3.2, 4.4);
  walls.translate(0, 1.6, 0);
  const roof = new ConeGeometry(4.0, 1.5, 4);
  roof.rotateY(Math.PI / 4);
  roof.translate(0, 3.95, 0);
  const annex = new BoxGeometry(2.6, 2.2, 2.6);
  annex.translate(3.4, 1.1, 0.8);
  return merged([paint(walls, '#b9ad99'), paint(roof, '#7d4a3a'), paint(annex, '#a89c88')]);
}

function rockGeometry(): BufferGeometry {
  const g = new IcosahedronGeometry(1, 0);
  return paint(g, '#7a7266');
}

export function Environment({ lowPower }: { lowPower: boolean }) {
  const dummy = useMemo(() => new Object3D(), []);

  const palm = useMemo(palmGeometry, []);
  const pine = useMemo(pineGeometry, []);
  const building = useMemo(buildingGeometry, []);
  const rock = useMemo(rockGeometry, []);

  const PALMS = lowPower ? 26 : 64;
  const PINES = lowPower ? 30 : 90;
  const BUILDINGS = lowPower ? 8 : 20;
  const ROCKS = lowPower ? 20 : 54;
  const SMOKE = lowPower ? 4 : 9;

  const palms = useRef<InstancedMesh>(null);
  const pines = useRef<InstancedMesh>(null);
  const buildings = useRef<InstancedMesh>(null);
  const rocks = useRef<InstancedMesh>(null);
  const smoke = useRef<InstancedMesh>(null);

  /**
   * Ridgelines. Three fogged bands of hills built from a displaced plane -
   * enough to close off the horizon and give the valley a shape.
   */
  const ridges = useMemo(() => {
    const make = (width: number, depth: number, height: number, seed: string, segs: number) => {
      const g = new PlaneGeometry(width, depth, segs, 4);
      g.rotateX(-Math.PI / 2);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        // Deterministic ridge profile: layered sines, tallest along the spine.
        const t = x / width;
        const h =
          height *
          (0.55 + 0.45 * Math.sin(t * 7.3 + hashUnit(seed) * 6)) *
          (0.5 + 0.5 * Math.cos(t * 3.1 + hashUnit(seed + 'b') * 6)) *
          (1 - Math.min(1, Math.abs(z) / (depth * 0.5)));
        pos.setY(i, Math.max(0, h));
      }
      g.computeVertexNormals();
      return g;
    };
    return {
      near: make(420, 90, 34, 'ridge-near', 42),
      mid: make(600, 120, 58, 'ridge-mid', 40),
      far: make(900, 150, 86, 'ridge-far', 36),
    };
  }, []);

  /** Sky dome: a simple vertical gradient baked into vertex colours. */
  const sky = useMemo(() => {
    const g = new SphereGeometry(420, 24, 16);
    const pos = g.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const horizon = new Color('#c8b79c');
    const zenith = new Color('#2c4460');
    const c = new Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 420;
      c.copy(horizon).lerp(zenith, Math.min(1, Math.max(0, y * 1.4 + 0.08)));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new BufferAttribute(colors, 3));
    return g;
  }, []);

  /* Static scatter: written once on the first frame, then left alone. */
  const placed = useRef(false);

  useFrame(() => {
    if (!placed.current) {
      placeScatter();
      placed.current = true;
    }

    // Smoke columns are the one moving piece - they rise and recycle.
    const mesh = smoke.current;
    if (!mesh) return;
    const t = runtime.elapsed;
    for (let i = 0; i < SMOKE; i++) {
      const seed = 'smoke' + i;
      const side = hashSigned(seed) > 0 ? 1 : -1;
      const baseX = side * (FIELD_HALF_X + 40 + hashUnit(seed + 'x') * 120);
      const baseZ = -70 - hashUnit(seed + 'z') * 130;
      // Each puff climbs, widens and fades out, then loops.
      const speed = 0.06 + hashUnitSalted(seed, 3) * 0.05;
      const p = (t * speed + hashUnit(seed + 'p')) % 1;
      const y = 6 + p * 46;
      const spread = 3 + p * 16;
      dummy.position.set(baseX + Math.sin(p * 3 + i) * 6, y, baseZ);
      dummy.rotation.set(0, p * 2, 0);
      dummy.scale.setScalar(Math.max(0.01, spread * (1 - p * 0.35)));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.count = SMOKE;
    mesh.instanceMatrix.needsUpdate = true;
  });

  function placeScatter(): void {
    /**
     * Keep scenery clear of the fighting area, and strictly *behind* it.
     *
     * The camera looks from +Z, so anything on the near side sits between the
     * viewer and the battle — at this camera distance a near-side building
     * fills a third of the screen. The whole valley therefore goes beyond the
     * field; what little goes near-side is pushed far out to the flanks where
     * it frames the shot instead of blocking it.
     */
    const outsideZ = (seed: string) => -(FIELD_HALF_Z + 10 + hashUnit(seed) * 80);

    const palmMesh = palms.current;
    if (palmMesh) {
      for (let i = 0; i < PALMS; i++) {
        const s = 'palm' + i;
        dummy.position.set(
          hashSigned(s + 'x') * (FIELD_HALF_X + 55),
          0,
          outsideZ(s + 'z'),
        );
        dummy.rotation.set(0, hashUnit(s + 'r') * Math.PI * 2, hashSigned(s + 't') * 0.06);
        dummy.scale.setScalar(0.8 + hashUnit(s + 's') * 0.7);
        dummy.updateMatrix();
        palmMesh.setMatrixAt(i, dummy.matrix);
      }
      palmMesh.count = PALMS;
      palmMesh.instanceMatrix.needsUpdate = true;
    }

    const pineMesh = pines.current;
    if (pineMesh) {
      for (let i = 0; i < PINES; i++) {
        const s = 'pine' + i;
        // Pines live further out, climbing the lower slopes.
        const z = outsideZ(s + 'z') * 1.6 - 30;
        dummy.position.set(hashSigned(s + 'x') * (FIELD_HALF_X + 130), 0, z);
        dummy.rotation.set(0, hashUnit(s + 'r') * Math.PI * 2, 0);
        dummy.scale.setScalar(1.1 + hashUnit(s + 's') * 1.3);
        dummy.updateMatrix();
        pineMesh.setMatrixAt(i, dummy.matrix);
      }
      pineMesh.count = PINES;
      pineMesh.instanceMatrix.needsUpdate = true;
    }

    const buildingMesh = buildings.current;
    if (buildingMesh) {
      for (let i = 0; i < BUILDINGS; i++) {
        const s = 'bld' + i;
        const side = i % 2 === 0 ? 1 : -1;
        dummy.position.set(
          hashSigned(s + 'x') * (FIELD_HALF_X + 70),
          0,
          side * (FIELD_HALF_Z + 26 + hashUnit(s + 'z') * 60),
        );
        dummy.rotation.set(0, Math.round(hashUnit(s + 'r') * 4) * (Math.PI / 2), 0);
        dummy.scale.setScalar(0.9 + hashUnit(s + 's') * 0.6);
        dummy.updateMatrix();
        buildingMesh.setMatrixAt(i, dummy.matrix);
      }
      buildingMesh.count = BUILDINGS;
      buildingMesh.instanceMatrix.needsUpdate = true;
    }

    const rockMesh = rocks.current;
    if (rockMesh) {
      for (let i = 0; i < ROCKS; i++) {
        const s = 'rock' + i;
        dummy.position.set(
          hashSigned(s + 'x') * (FIELD_HALF_X + 60),
          hashUnit(s + 'y') * 0.3,
          outsideZ(s + 'z') * 1.15,
        );
        dummy.rotation.set(hashUnit(s + 'a') * 3, hashUnit(s + 'b') * 3, hashUnit(s + 'c') * 3);
        const sc = 0.5 + hashUnit(s + 's') * 1.8;
        dummy.scale.set(sc, sc * 0.7, sc * 1.1);
        dummy.updateMatrix();
        rockMesh.setMatrixAt(i, dummy.matrix);
      }
      rockMesh.count = ROCKS;
      rockMesh.instanceMatrix.needsUpdate = true;
    }
  }

  return (
    <group>
      {/* Sky dome - drawn inside-out behind everything. */}
      <mesh geometry={sky} frustumCulled={false}>
        <meshBasicMaterial vertexColors side={BackSide} depthWrite={false} fog={false} />
      </mesh>


      {/* Ridgelines */}
      <mesh geometry={ridges.far} position={[0, -4, -300]} frustumCulled={false}>
        <meshStandardMaterial color="#5d6470" roughness={1} flatShading />
      </mesh>
      <mesh geometry={ridges.mid} position={[0, -3, -210]} frustumCulled={false}>
        <meshStandardMaterial color="#5a5f4e" roughness={1} flatShading />
      </mesh>
      <mesh geometry={ridges.near} position={[0, -2, -140]} frustumCulled={false}>
        <meshStandardMaterial color="#59583f" roughness={1} flatShading />
      </mesh>
      <mesh geometry={ridges.mid} position={[0, -3, 210]} rotation={[0, Math.PI, 0]} frustumCulled={false}>
        <meshStandardMaterial color="#585d4d" roughness={1} flatShading />
      </mesh>

      {/* Vegetation and props */}
      <instancedMesh ref={palms} args={[undefined, undefined, PALMS]} frustumCulled={false} castShadow={!lowPower}>
        <primitive object={palm} attach="geometry" />
        <meshStandardMaterial vertexColors roughness={0.85} />
      </instancedMesh>

      <instancedMesh ref={pines} args={[undefined, undefined, PINES]} frustumCulled={false}>
        <primitive object={pine} attach="geometry" />
        <meshStandardMaterial vertexColors roughness={0.9} />
      </instancedMesh>

      <instancedMesh ref={buildings} args={[undefined, undefined, BUILDINGS]} frustumCulled={false} castShadow={!lowPower}>
        <primitive object={building} attach="geometry" />
        <meshStandardMaterial vertexColors roughness={0.88} />
      </instancedMesh>

      <instancedMesh ref={rocks} args={[undefined, undefined, ROCKS]} frustumCulled={false} castShadow={!lowPower}>
        <primitive object={rock} attach="geometry" />
        <meshStandardMaterial vertexColors roughness={1} flatShading />
      </instancedMesh>

      {/* Distant smoke columns. Kept faint and far out — as opaque spheres they
          read as floating balls rather than smoke. */}
      <instancedMesh ref={smoke} args={[undefined, undefined, SMOKE]} frustumCulled={false}>
        <sphereGeometry args={[1, 8, 6]} />
        <meshStandardMaterial color="#6a6558" transparent opacity={0.13} depthWrite={false} roughness={1} />
      </instancedMesh>
    </group>
  );
}
