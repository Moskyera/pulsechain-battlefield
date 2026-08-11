/**
 * Deterministic hashing.
 *
 * The battlefield never calls Math.random(). Where a visual needs variety —
 * which lane a unit spawns in, how far off-centre an explosion lands, the
 * jitter on a formation — that variety is derived from real on-chain bytes
 * (a transaction hash, a pair address, a unit index).
 *
 * Same transaction => same trajectory, on every machine, on every reload.
 */

/** FNV-1a 32-bit. Fast, stable, good enough spread for visual placement. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic float in [0, 1) derived from a string. */
export function hashUnit(input: string): number {
  return hash32(input) / 0x100000000;
}

/** Deterministic float in [-1, 1) derived from a string. */
export function hashSigned(input: string): number {
  return hashUnit(input) * 2 - 1;
}

/**
 * Deterministic float in [0, 1) from a string plus a salt, so one transaction
 * hash can drive several independent-looking values (lane, arc height, spread).
 */
export function hashUnitSalted(input: string, salt: number): number {
  return hashUnit(input + ':' + salt);
}

/** Deterministic integer in [0, max) from a string. */
export function hashInt(input: string, max: number): number {
  if (max <= 0) return 0;
  return hash32(input) % max;
}
