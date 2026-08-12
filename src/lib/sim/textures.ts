'use client';

/**
 * Procedural surface textures.
 *
 * Generated into a canvas at runtime rather than loaded as image files: no
 * assets to ship, nothing to 404, and no licensing. Every texture is produced
 * from a seeded LCG, so the battlefield looks identical on every machine and
 * every reload — the same rule the rest of the app follows.
 *
 * These are *detail* maps, deliberately near-white. Soldiers, vehicles and
 * terrain all carry their real colour in baked vertex colours; three multiplies
 * `map x vertexColor x material.color`, so a mostly-white texture adds grain,
 * wear and grime without touching the underlying palette. A coloured texture
 * here would fight the vertex colours and turn everything to mud.
 */

import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Texture } from 'three';

/** Seeded linear congruential generator — deterministic, no Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface DetailOptions {
  /** Canvas edge length in pixels. */
  size?: number;
  /** 0 = flat white, 1 = heavy grain. */
  grain?: number;
  /** Number of larger wear blotches. */
  blotches?: number;
  /** Number of fine scratches / streaks. */
  scratches?: number;
  /** Base grey level, 0-255. */
  base?: number;
}

const cache = new Map<string, Texture>();

/**
 * A tiling wear/grime map: fine grain, soft blotches and thin scratches on a
 * near-white base.
 */
export function detailTexture(key: string, seed: number, opts: DetailOptions = {}): Texture | null {
  if (typeof document === 'undefined') return null;

  const cached = cache.get(key);
  if (cached) return cached;

  const size = opts.size ?? 256;
  const grain = opts.grain ?? 0.28;
  const blotches = opts.blotches ?? 26;
  const scratches = opts.scratches ?? 18;
  const base = opts.base ?? 232;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const rnd = lcg(seed);

  ctx.fillStyle = `rgb(${base},${base},${base})`;
  ctx.fillRect(0, 0, size, size);

  // Soft wear blotches. Drawn twice with wrap-around offsets so the texture
  // tiles seamlessly instead of showing a seam at the edges.
  for (let i = 0; i < blotches; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = size * (0.04 + rnd() * 0.13);
    const dark = base - 30 - rnd() * 55;
    for (const [ox, oy] of [
      [0, 0],
      [size, 0],
      [-size, 0],
      [0, size],
      [0, -size],
    ]) {
      const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      g.addColorStop(0, `rgba(${dark},${dark},${dark},0.5)`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Scratches and streaks.
  ctx.lineCap = 'round';
  for (let i = 0; i < scratches; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const len = size * (0.05 + rnd() * 0.3);
    const ang = rnd() * Math.PI * 2;
    const shade = base - 40 - rnd() * 60;
    ctx.strokeStyle = `rgba(${shade},${shade},${shade},${0.16 + rnd() * 0.3})`;
    ctx.lineWidth = 0.5 + rnd() * 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }

  // Per-pixel grain on top.
  if (grain > 0) {
    const img = ctx.getImageData(0, 0, size, size);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rnd() - 0.5) * 255 * grain;
      d[i] = Math.max(0, Math.min(255, d[i] + n));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
    }
    ctx.putImageData(img, 0, 0);
  }

  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  cache.set(key, tex);
  return tex;
}

/**
 * A single soft puff, for smoke billboards.
 *
 * White, with the shape carried entirely in the alpha channel: a soft radial
 * falloff broken up by noise so the edge is ragged rather than a clean circle.
 * Several of these overlapping at different sizes and speeds is what turns a
 * hard-edged sphere into something that reads as smoke.
 */
export function puffTexture(): Texture | null {
  if (typeof document === 'undefined') return null;

  const cached = cache.get('puff');
  if (cached) return cached;

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const rnd = lcg(0x2f8ac1);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const mid = size / 2;

  // Lumps in the outline, so no two puffs read as the same circle.
  const lobes = Array.from({ length: 7 }, () => ({
    a: rnd() * Math.PI * 2,
    r: 0.16 + rnd() * 0.2,
    w: 0.5 + rnd() * 0.7,
  }));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - mid) / mid;
      const dy = (y - mid) / mid;
      const dist = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);

      let edge = 0.82;
      for (const l of lobes) {
        const delta = Math.cos(ang - l.a);
        edge += l.r * Math.pow(Math.max(0, delta), 2 / l.w) - l.r * 0.35;
      }

      // Soft all the way in, so overlapping puffs blend instead of banding.
      let a = 1 - dist / Math.max(0.2, edge);
      a = Math.max(0, Math.min(1, a));
      a = a * a * (3 - 2 * a);
      a *= 0.82 + rnd() * 0.18;

      const i = (y * size + x) * 4;
      d[i] = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
      d[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 2;
  cache.set('puff', tex);
  return tex;
}

/* ------------------------------------------------------------------ relief */

/**
 * Seamless value noise on a periodic lattice.
 *
 * The lattice wraps, so the field tiles exactly: without that every surface
 * shows a grid of seams once the texture repeats, which on the terrain would be
 * ninety times across.
 */
function valueNoise(size: number, cells: number, seed: number): Float32Array {
  const rnd = lcg(seed);
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();

  const out = new Float32Array(size * size);
  const scale = cells / size;
  const smooth = (t: number) => t * t * (3 - 2 * t);

  for (let y = 0; y < size; y++) {
    const fy = y * scale;
    const y0 = Math.floor(fy);
    const ty = smooth(fy - y0);
    for (let x = 0; x < size; x++) {
      const fx = x * scale;
      const x0 = Math.floor(fx);
      const tx = smooth(fx - x0);

      const x1 = (x0 + 1) % cells;
      const y1 = (y0 + 1) % cells;
      const a = lattice[(y0 % cells) * cells + (x0 % cells)];
      const b = lattice[(y0 % cells) * cells + x1];
      const c = lattice[y1 * cells + (x0 % cells)];
      const d = lattice[y1 * cells + x1];

      out[y * size + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

interface ReliefOptions {
  size?: number;
  /** Lattice sizes to sum, coarse first. Each must divide the canvas cleanly. */
  octaves?: number[];
  /** How pronounced the slopes are. */
  strength?: number;
  /** Adds a woven cross-hatch on top, for cloth. */
  weave?: number;
}

const normalCache = new Map<string, Texture>();

/**
 * A tangent-space normal map, derived from a procedural height field.
 *
 * Flat colour is what makes a surface read as a polygon rather than a material:
 * with no relief, a lit plane is a single flat wash however good the light is.
 * This gives every surface slopes to catch that light, which is the difference
 * between painted ground and ground made of grit.
 *
 * Heights are converted with a Sobel difference and encoded the usual way, and
 * the texture is deliberately left in linear space: a normal map holds
 * directions, not colour, so running it through sRGB would bend every vector.
 */
export function reliefTexture(key: string, seed: number, opts: ReliefOptions = {}): Texture | null {
  if (typeof document === 'undefined') return null;

  const cached = normalCache.get(key);
  if (cached) return cached;

  const size = opts.size ?? 256;
  const octaves = opts.octaves ?? [8, 32, 128];
  const strength = opts.strength ?? 2.2;
  const weave = opts.weave ?? 0;

  // Build the height field: coarse shapes first, finer detail at lower weight.
  const height = new Float32Array(size * size);
  let amplitude = 1;
  let total = 0;
  for (let o = 0; o < octaves.length; o++) {
    const layer = valueNoise(size, Math.min(octaves[o], size), seed + o * 7919);
    for (let i = 0; i < height.length; i++) height[i] += layer[i] * amplitude;
    total += amplitude;
    amplitude *= 0.55;
  }
  for (let i = 0; i < height.length; i++) height[i] /= total;

  if (weave > 0) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const w =
          Math.sin((x / size) * Math.PI * 2 * 24) * Math.sin((y / size) * Math.PI * 2 * 24);
        height[y * size + x] += w * weave;
      }
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const img = ctx.createImageData(size, size);
  const d = img.data;
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      d[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      d[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      d[i + 2] = (1 / len) * 0.5 * 255 + 127.5;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.anisotropy = 4;
  normalCache.set(key, tex);
  return tex;
}

/** Grit and clods for the ground. Tiled at the same rate as its detail map. */
export function groundNormal(repeat = 90): Texture | null {
  const tex = reliefTexture('ground-relief', 0x9d31f7, {
    size: 256,
    octaves: [8, 32, 128],
    strength: 3.4,
  });
  if (tex) tex.repeat.set(repeat, repeat * 0.8);
  return tex;
}

/** Rolled plate, dents and weld seams. */
export function armourNormal(): Texture | null {
  const tex = reliefTexture('armour-relief', 0x4417ab, {
    size: 256,
    octaves: [4, 16, 64],
    strength: 2.1,
  });
  if (tex) tex.repeat.set(3, 3);
  return tex;
}

/** Coarse woven cloth. */
export function troopNormal(): Texture | null {
  const tex = reliefTexture('troop-relief', 0x1f77b4, {
    size: 128,
    octaves: [8, 32],
    strength: 1.5,
    weave: 0.16,
  });
  if (tex) tex.repeat.set(2, 2);
  return tex;
}

/** Hessian sacking for the parapet. */
export function sackNormal(): Texture | null {
  const tex = reliefTexture('sack-relief', 0x6ab04c, {
    size: 128,
    octaves: [4, 16, 64],
    strength: 2.6,
    weave: 0.22,
  });
  if (tex) tex.repeat.set(1.6, 1.6);
  return tex;
}

/**
 * Gravel and scuff for the terrain. Tiled hard, so the ground reads as a
 * surface rather than a flat-shaded polygon at any zoom.
 */
export function groundTexture(repeat = 90): Texture | null {
  const tex = detailTexture('ground', 0x51f3a2, {
    size: 512,
    grain: 0.34,
    blotches: 40,
    scratches: 30,
    base: 236,
  });
  if (tex) tex.repeat.set(repeat, repeat * 0.8);
  return tex;
}

/** Panel wear, weld lines and exhaust staining for armour. */
export function armourTexture(): Texture | null {
  const tex = detailTexture('armour', 0x2ba7c1, {
    size: 256,
    grain: 0.16,
    blotches: 20,
    scratches: 26,
    base: 226,
  });
  if (tex) tex.repeat.set(3, 3);
  return tex;
}

/** Fabric weave and field dirt for uniforms and kit. */
export function troopTexture(): Texture | null {
  const tex = detailTexture('troop', 0x7c1de9, {
    size: 128,
    grain: 0.22,
    blotches: 10,
    scratches: 8,
    base: 230,
  });
  if (tex) tex.repeat.set(2, 2);
  return tex;
}
