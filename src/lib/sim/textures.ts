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
