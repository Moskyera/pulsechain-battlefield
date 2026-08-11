'use client';

/**
 * Unit geometry.
 *
 * Every unit is built from primitives and merged into a *single* BufferGeometry,
 * because InstancedMesh draws one geometry. The trick that makes them look like
 * people rather than coloured blobs is **baked vertex colours**: each body part
 * carries its own colour in the merged buffer, so one instanced draw call
 * renders a soldier with skin, olive fatigues, body armour, boots and a
 * gunmetal rifle.
 *
 * Team identity is added by the material's `emissive`, not by tinting the whole
 * model — so both armies read as real soldiers first, green/red second.
 *
 * Orientation convention:
 *   Soldiers and tanks face **+X** (placed with `rotation.y`).
 *   Rockets and tracers point along **+Z** (aimed with `Object3D.lookAt()`).
 */

import {
  BoxGeometry,
  BufferAttribute,
  Color,
  ConeGeometry,
  CylinderGeometry,
  SphereGeometry,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Paint every vertex of a part, so the merged mesh keeps per-part colour. */
function paint(geo: BufferGeometry, hex: string): BufferGeometry {
  const c = new Color(hex);
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new BufferAttribute(colors, 3));
  return geo;
}

function boxPart(
  hex: string,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  rot?: { x?: number; y?: number; z?: number },
): BufferGeometry {
  const g = new BoxGeometry(w, h, d);
  if (rot?.x) g.rotateX(rot.x);
  if (rot?.y) g.rotateY(rot.y);
  if (rot?.z) g.rotateZ(rot.z);
  g.translate(x, y, z);
  return paint(g, hex);
}

function limb(
  hex: string,
  radius: number,
  length: number,
  x: number,
  y: number,
  z: number,
  rot?: { x?: number; z?: number },
): BufferGeometry {
  const g = new CylinderGeometry(radius, radius * 0.92, length, 7);
  if (rot?.x) g.rotateX(rot.x);
  if (rot?.z) g.rotateZ(rot.z);
  g.translate(x, y, z);
  return paint(g, hex);
}

function ball(hex: string, radius: number, x: number, y: number, z: number, squashY = 1): BufferGeometry {
  const g = new SphereGeometry(radius, 9, 7);
  if (squashY !== 1) g.scale(1, squashY, 1);
  g.translate(x, y, z);
  return paint(g, hex);
}

function merge(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('failed to merge unit geometry');
  merged.computeVertexNormals();
  return merged;
}

/* Palette. Real uniform tones: the team colour is carried by a few small,
   deliberately bright markers rather than by dyeing the whole man. */
const SKIN = '#c08a5e';
const BOOT = '#1b1b18';
const GUNMETAL = '#23262a';

/**
 * One army's kit.
 *
 * Both sides used to wear the same olive and were told apart only by an
 * emissive wash that turned them into solid green or solid red silhouettes,
 * which is what made them read as plastic toys. Now they wear genuinely
 * different uniforms and carry a helmet band and an armband in their colour:
 * identifiable at a glance, still soldiers up close.
 *
 * The markers are baked into the vertex colours, so each side simply gets its
 * own cached geometry and the draw-call count does not move.
 */
export interface TeamKit {
  key: string;
  fatigue: string;
  fatigueDark: string;
  helmet: string;
  armour: string;
  pack: string;
  /** Hull and turret tone for this side's armour. */
  hull: string;
  turret: string;
  /** The bright identifying colour: bands, stripes, pennants. */
  marker: string;
}

export const KIT_BUY: TeamKit = {
  key: 'buy',
  fatigue: '#4f5b3c',
  fatigueDark: '#3c4630',
  helmet: '#39422f',
  armour: '#2b3327',
  pack: '#57603f',
  hull: '#333b33',
  turret: '#3d463c',
  marker: '#3ff08a',
};

export const KIT_SELL: TeamKit = {
  key: 'sell',
  fatigue: '#6b5b47',
  fatigueDark: '#514537',
  helmet: '#57493a',
  armour: '#3a3028',
  pack: '#6f6049',
  hull: '#3b3532',
  turret: '#46403b',
  marker: '#ff5566',
};

const soldierCache = new Map<string, BufferGeometry>();
const tankCache = new Map<string, BufferGeometry>();
const launcherCacheByTeam = new Map<string, BufferGeometry>();
let rocketCache: BufferGeometry | null = null;
let tracerCache: BufferGeometry | null = null;

/**
 * An infantryman, ~1.8 units tall, in a firing stance facing +X.
 *
 * Now that only ~20 stand per side, each one can afford real anatomy: rounded
 * head and limbs, body armour over fatigues, a pack, boots, and a rifle held
 * across the chest. Roughly 900 vertices — irrelevant at 40 instances, and it
 * is the difference between "figures" and "soldiers".
 */
export function soldierGeometry(kit: TeamKit): BufferGeometry {
  const cached = soldierCache.get(kit.key);
  if (cached) return cached;

  const parts: BufferGeometry[] = [
    // Boots and legs, stance slightly open with the lead leg forward.
    boxPart(BOOT, 0.3, 0.12, 0.18, 0.1, 0.06, -0.15),
    boxPart(BOOT, 0.3, 0.12, 0.18, -0.06, 0.06, 0.16),
    limb(kit.fatigueDark, 0.1, 0.62, 0.06, 0.42, -0.15, { z: 0.06 }),
    limb(kit.fatigueDark, 0.1, 0.62, -0.03, 0.42, 0.16, { z: -0.04 }),

    // Hips + belt
    boxPart(kit.fatigue, 0.26, 0.18, 0.42, 0, 0.8, 0),
    boxPart(BOOT, 0.28, 0.06, 0.44, 0, 0.88, 0),

    // Torso, then body armour over it
    boxPart(kit.fatigue, 0.28, 0.5, 0.44, 0, 1.15, 0),
    boxPart(kit.armour, 0.31, 0.36, 0.47, 0, 1.16, 0),
    // pouches
    boxPart(kit.armour, 0.1, 0.12, 0.12, 0.16, 1.02, -0.12),
    boxPart(kit.armour, 0.1, 0.12, 0.12, 0.16, 1.02, 0.12),

    // Pack on the back (behind = -X)
    boxPart(kit.pack, 0.2, 0.4, 0.36, -0.24, 1.16, 0),

    // Shoulders
    ball(kit.fatigue, 0.12, 0, 1.36, -0.24),
    ball(kit.fatigue, 0.12, 0, 1.36, 0.24),

    // Upper arms angled forward, forearms bringing the rifle across the chest
    limb(kit.fatigue, 0.082, 0.34, 0.08, 1.2, -0.26, { z: -0.35 }),
    limb(kit.fatigue, 0.082, 0.34, 0.1, 1.2, 0.26, { z: -0.45 }),
    limb(SKIN, 0.072, 0.28, 0.27, 1.06, -0.2, { z: Math.PI / 2.1 }),
    limb(SKIN, 0.072, 0.26, 0.3, 1.12, 0.18, { z: Math.PI / 2.1 }),

    // Neck + head + helmet
    limb(SKIN, 0.07, 0.1, 0, 1.46, 0),
    ball(SKIN, 0.125, 0.01, 1.58, 0),
    ball(kit.helmet, 0.152, 0.01, 1.6, 0, 0.78),
    boxPart(kit.helmet, 0.1, 0.04, 0.26, 0.13, 1.58, 0),

    // Field signs. Small, bright and in the two places you actually look from
    // a high camera: a band round the helmet and a strip on the shoulder.
    boxPart(kit.marker, 0.3, 0.045, 0.3, 0.01, 1.655, 0),
    boxPart(kit.marker, 0.13, 0.16, 0.05, 0.02, 1.3, -0.245),

    // Rifle: receiver, barrel, magazine, stock — held out front
    boxPart(GUNMETAL, 0.44, 0.075, 0.075, 0.26, 1.12, 0.02),
    boxPart(GUNMETAL, 0.3, 0.042, 0.042, 0.6, 1.12, 0.02),
    boxPart(GUNMETAL, 0.07, 0.16, 0.06, 0.26, 1.02, 0.02),
    boxPart(GUNMETAL, 0.2, 0.09, 0.06, -0.02, 1.14, 0.02),
  ];

  const geo = merge(parts);
  soldierCache.set(kit.key, geo);
  return geo;
}

/**
 * A tank: tracks with road wheels, sloped hull, turret and gun, facing +X.
 * Deployed for real trades at or above the tank cutoff.
 */
export function tankGeometry(kit: TeamKit): BufferGeometry {
  const cached = tankCache.get(kit.key);
  if (cached) return cached;

  // Readability first. Against tan dirt an olive tank is a lump, so the hull is
  // dark gunmetal for contrast, the turret sits high and clear of the deck, and
  // the gun is long and thick enough to be obvious from the default camera —
  // the barrel is what makes a shape read as "tank" at a glance.
  const HULL = kit.hull;
  const TURRET = kit.turret;
  const STEEL = '#22262b';
  const TRACK = '#141619';
  const PACK = kit.pack;

  const barrel = new CylinderGeometry(0.11, 0.125, 2.0, 10);
  barrel.rotateZ(-Math.PI / 2);
  barrel.translate(1.6, 1.06, 0);

  const muzzle = new CylinderGeometry(0.16, 0.16, 0.26, 10);
  muzzle.rotateZ(-Math.PI / 2);
  muzzle.translate(2.5, 1.06, 0);

  const mantlet = new CylinderGeometry(0.26, 0.26, 0.5, 10);
  mantlet.rotateZ(-Math.PI / 2);
  mantlet.translate(0.62, 1.06, 0);

  // Antenna — a thin vertical line reads at distance and breaks the silhouette.
  const antenna = new CylinderGeometry(0.025, 0.025, 1.5, 5);
  antenna.translate(-0.55, 1.85, 0.3);

  const wheels: BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    for (const z of [-0.58, 0.58]) {
      const wg = new CylinderGeometry(0.22, 0.22, 0.2, 12);
      wg.rotateX(Math.PI / 2);
      wg.translate(-0.85 + i * 0.34, 0.24, z);
      wheels.push(paint(wg, '#0e1013'));
    }
  }

  // Drive sprocket and idler, one at each end of the run — the shapes that make
  // a track look driven rather than painted on.
  for (const [x, z] of [[-1.12, -0.6], [-1.12, 0.6], [1.12, -0.6], [1.12, 0.6]] as const) {
    const s = new CylinderGeometry(0.28, 0.28, 0.24, 12);
    s.rotateX(Math.PI / 2);
    s.translate(x, 0.3, z);
    wheels.push(paint(s, '#191c21'));
  }

  const parts: BufferGeometry[] = [
    // Tracks: tall and dark, so the running gear is unmistakable.
    boxPart(TRACK, 2.25, 0.5, 0.34, 0, 0.25, -0.6),
    boxPart(TRACK, 2.25, 0.5, 0.34, 0, 0.25, 0.6),
    ...wheels,
    // Fenders over the tracks
    boxPart(STEEL, 2.3, 0.08, 0.44, 0, 0.53, -0.6),
    boxPart(STEEL, 2.3, 0.08, 0.44, 0, 0.53, 0.6),

    // Hull + sloped glacis plate
    boxPart(HULL, 2.05, 0.42, 1.05, 0, 0.72, 0),
    boxPart(HULL, 0.62, 0.3, 1.0, 1.0, 0.82, 0, { z: -0.5 }),

    // Turret, raised well clear of the deck
    boxPart(TURRET, 1.15, 0.46, 0.95, -0.12, 1.16, 0),
    boxPart(TURRET, 0.5, 0.34, 0.62, 0.42, 1.14, 0),
    paint(mantlet, STEEL),
    paint(barrel, STEEL),
    paint(muzzle, STEEL),

    // Cupola, hatch and antenna
    ball(TURRET, 0.24, -0.42, 1.44, 0.1, 0.75),
    boxPart('#1a1d21', 0.3, 0.06, 0.3, -0.42, 1.56, 0.1),
    paint(antenna, '#1a1d21'),

    // Stowage and spare track links
    boxPart(PACK, 0.42, 0.24, 0.78, -0.86, 1.02, 0),
    boxPart(STEEL, 0.5, 0.1, 0.14, 0.5, 0.95, -0.5),

    // Side skirts over the running gear
    boxPart(STEEL, 2.0, 0.3, 0.06, 0, 0.62, -0.82),
    boxPart(STEEL, 2.0, 0.3, 0.06, 0, 0.62, 0.82),

    // Turret bustle rack and a commander's machine gun beside the hatch
    boxPart('#2a2f36', 0.4, 0.26, 0.8, -0.78, 1.2, 0),
    boxPart(STEEL, 0.42, 0.06, 0.06, -0.28, 1.62, 0.28),
    boxPart(STEEL, 0.12, 0.14, 0.1, -0.46, 1.58, 0.28),

    // Exhaust louvres and headlights: small, but they break up flat slabs.
    boxPart('#15181c', 0.16, 0.16, 0.3, -1.0, 0.86, -0.36),
    boxPart('#15181c', 0.16, 0.16, 0.3, -1.0, 0.86, 0.36),
    boxPart('#c9cdd2', 0.06, 0.12, 0.14, 1.06, 0.72, -0.36),
    boxPart('#c9cdd2', 0.06, 0.12, 0.14, 1.06, 0.72, 0.36),

    // Tow hooks on the glacis
    boxPart(STEEL, 0.14, 0.08, 0.08, 1.08, 0.5, -0.24),
    boxPart(STEEL, 0.14, 0.08, 0.08, 1.08, 0.5, 0.24),

    // Recognition stripes: turret flanks and a panel on the roof, so the side
    // is obvious both from across the field and from the default camera above.
    boxPart(kit.marker, 0.72, 0.1, 0.04, -0.12, 1.24, -0.48),
    boxPart(kit.marker, 0.72, 0.1, 0.04, -0.12, 1.24, 0.48),
    boxPart(kit.marker, 0.34, 0.03, 0.34, -0.05, 1.4, -0.22),
  ];

  const geo = merge(parts);
  tankCache.set(kit.key, geo);
  return geo;
}

/**
 * A rocket / missile, nose pointing **+Z** for `lookAt` aiming.
 * Used for every tier above infantry; scaled up for artillery and nukes.
 */
export function rocketGeometry(): BufferGeometry {
  if (rocketCache) return rocketCache;

  const body = new CylinderGeometry(0.13, 0.13, 0.8, 12);
  body.rotateX(Math.PI / 2);

  const band = new CylinderGeometry(0.145, 0.145, 0.12, 12);
  band.rotateX(Math.PI / 2);
  band.translate(0, 0, 0.1);

  // Second band aft, so the body isn't one blank tube.
  const band2 = new CylinderGeometry(0.142, 0.142, 0.08, 12);
  band2.rotateX(Math.PI / 2);
  band2.translate(0, 0, -0.22);

  const nose = new ConeGeometry(0.13, 0.4, 12);
  nose.rotateX(Math.PI / 2);
  nose.translate(0, 0, 0.6);

  const nozzle = new ConeGeometry(0.12, 0.16, 12);
  nozzle.rotateX(-Math.PI / 2);
  nozzle.translate(0, 0, -0.44);

  const fins: BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const fin = new BoxGeometry(0.035, 0.28, 0.24);
    fin.translate(0, 0.19, -0.3);
    fin.rotateZ((i / 4) * Math.PI * 2);
    fins.push(paint(fin, '#8d9299'));

    // Forward canards: the detail that reads as "guided" at close zoom.
    const canard = new BoxGeometry(0.03, 0.14, 0.13);
    canard.translate(0, 0.15, 0.3);
    canard.rotateZ((i / 4) * Math.PI * 2 + Math.PI / 4);
    fins.push(paint(canard, '#a7adb4'));
  }

  rocketCache = merge([
    paint(body, '#d8dde3'),
    paint(band, '#b23a3a'),
    paint(band2, '#7d848c'),
    paint(nose, '#2f3338'),
    paint(nozzle, '#4a4f55'),
    ...fins,
  ]);
  return rocketCache;
}

/**
 * A truck-mounted rocket launcher, facing +X — the artillery that sits dug in
 * behind the line waiting on a big trade.
 */
export function launcherGeometry(kit: TeamKit): BufferGeometry {
  const cached = launcherCacheByTeam.get(kit.key);
  if (cached) return cached;

  const PACK = kit.pack;
  const wheels: BufferGeometry[] = [];
  for (const x of [-0.7, 0.05, 0.72]) {
    for (const z of [-0.5, 0.5]) {
      const w = new CylinderGeometry(0.28, 0.28, 0.22, 10);
      w.rotateX(Math.PI / 2);
      w.translate(x, 0.28, z);
      wheels.push(paint(w, '#0e1013'));
    }
  }

  // A boxed rack of launch tubes, tilted up. The raised angled block is what
  // distinguishes a launcher from a tank at a glance, so it is deliberately
  // large and sits high on the bed.
  const rack: BufferGeometry[] = [];
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) {
      const tube = new CylinderGeometry(0.11, 0.11, 1.5, 8);
      tube.rotateZ(Math.PI / 2);
      tube.translate(0, 0, -0.42 + col * 0.28);
      tube.rotateZ(0.5);
      tube.translate(-0.45, 1.12 + row * 0.26, 0);
      rack.push(paint(tube, '#20242a'));
    }
  }

  const parts: BufferGeometry[] = [
    ...wheels,
    // chassis + cab
    boxPart('#2f343a', 2.1, 0.26, 1.0, 0, 0.46, 0),
    boxPart('#3d434b', 0.78, 0.62, 0.94, 0.72, 0.9, 0),
    boxPart('#12161a', 0.07, 0.34, 0.8, 1.1, 1.0, 0),
    // launcher cradle the tubes sit in
    boxPart('#3a4149', 1.15, 0.2, 1.0, -0.42, 0.72, 0, { z: 0.5 }),
    ...rack,

    // Mudguards over each axle
    boxPart('#262b31', 0.5, 0.06, 0.16, -0.7, 0.58, -0.5),
    boxPart('#262b31', 0.5, 0.06, 0.16, -0.7, 0.58, 0.5),
    boxPart('#262b31', 0.5, 0.06, 0.16, 0.72, 0.58, -0.5),
    boxPart('#262b31', 0.5, 0.06, 0.16, 0.72, 0.58, 0.5),

    // Hydraulic ram holding the rack up, and the outrigger legs it rests on
    boxPart('#5a626b', 0.5, 0.09, 0.09, -0.1, 0.86, -0.3, { z: 0.5 }),
    boxPart('#5a626b', 0.5, 0.09, 0.09, -0.1, 0.86, 0.3, { z: 0.5 }),
    boxPart('#22262b', 0.12, 0.34, 0.12, -1.0, 0.28, -0.52),
    boxPart('#22262b', 0.12, 0.34, 0.12, -1.0, 0.28, 0.52),

    // Reload crate on the bed and a cab step
    boxPart(PACK, 0.42, 0.22, 0.7, 0.25, 0.66, 0),
    boxPart('#15181c', 0.24, 0.05, 0.5, 0.72, 0.5, 0),

    // Recognition stripes down the cab and across the bed.
    boxPart(kit.marker, 0.06, 0.34, 0.96, 0.36, 0.9, 0),
    boxPart(kit.marker, 0.3, 0.03, 0.5, -0.1, 0.6, 0),
  ];

  const geo = merge(parts);
  launcherCacheByTeam.set(kit.key, geo);
  return geo;
}

/** A rifle tracer: a bead stretched along its flight path. */
export function tracerGeometry(): BufferGeometry {
  if (tracerCache) return tracerCache;
  tracerCache = new SphereGeometry(1, 6, 4);
  return tracerCache;
}
