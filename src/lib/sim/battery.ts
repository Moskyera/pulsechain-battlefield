/**
 * The standing gun line — one shared definition.
 *
 * Both the renderer (Emplacements) and the combat system read this, so the
 * guns that appear on screen are exactly the guns that fire. Previously the
 * combat system conjured a throwaway vehicle at the moment of each big trade,
 * which meant two disconnected sets of armour: a permanent battery that never
 * shot, and phantom tanks that appeared, fired and vanished.
 */

import { hashInt } from '../util/hash';
import { FIELD_HALF_Z, GREEN_BASE_X, RED_BASE_X, frontLineToX } from './layout';
import type { Side } from '../data/types';

export type PieceKind = 'tank' | 'launcher';

export interface BatteryPiece {
  kind: PieceKind;
  scale: number;
  /** Position across the field width, -1..1. */
  lane: number;
}

/**
 * Fixed order of battle, dressed in a single lane: heavy armour holding the
 * centre, light armour on the shoulders, rocket artillery anchoring the flanks.
 */
export const BATTERY: readonly BatteryPiece[] = [
  { kind: 'launcher', scale: 1.9, lane: -0.86 },
  { kind: 'tank', scale: 1.6, lane: -0.52 },
  { kind: 'tank', scale: 2.2, lane: -0.17 },
  { kind: 'tank', scale: 2.2, lane: 0.17 },
  { kind: 'tank', scale: 1.6, lane: 0.52 },
  { kind: 'launcher', scale: 1.9, lane: 0.86 },
];

/** How far behind the front line the whole battery sits. */
export const BATTERY_STANDOFF = 26;

export const TANK_INDICES = BATTERY.map((p, i) => (p.kind === 'tank' ? i : -1)).filter((i) => i >= 0);
export const LAUNCHER_INDICES = BATTERY.map((p, i) => (p.kind === 'launcher' ? i : -1)).filter(
  (i) => i >= 0,
);

export interface PiecePlacement {
  x: number;
  z: number;
  /** World position of the gun/tube mouth, where a round leaves. */
  muzzleX: number;
  muzzleY: number;
  piece: BatteryPiece;
}

/**
 * Where a given battery piece stands, for a side, at the current front line.
 *
 * `dir` points back toward that side's own base, so the battery is placed
 * behind the line and clamped so it never reverses out through its own base.
 */
export function batteryPlacement(index: number, side: Side, frontLine: number): PiecePlacement {
  const piece = BATTERY[index % BATTERY.length];
  const dir = side === 'buy' ? -1 : 1;
  const faceDir = -dir;

  const frontX = frontLineToX(frontLine);
  const baseX = side === 'buy' ? GREEN_BASE_X : RED_BASE_X;
  const room = Math.max(8, Math.abs(baseX - frontX));

  const x = frontX + dir * Math.min(room - 3, BATTERY_STANDOFF);
  const z = piece.lane * FIELD_HALF_Z * 0.92;

  // Gun mouth: out along the barrel for a tank, just clear of the raised tube
  // rack for a launcher.
  const reach = piece.kind === 'tank' ? 2.6 : 0.6;
  const height = piece.kind === 'tank' ? 1.06 : 1.35;

  return {
    x,
    z,
    muzzleX: x + faceDir * reach * piece.scale,
    muzzleY: height * piece.scale,
    piece,
  };
}

/**
 * Pick which piece answers a given trade: rocket artillery for the big ones,
 * tanks for the rest. Deterministic from the transaction hash, so the same
 * trade is always answered by the same gun.
 */
export function pieceForTrade(txHash: string, heavy: boolean): number {
  const pool = heavy ? LAUNCHER_INDICES : TANK_INDICES;
  return pool[hashInt(txHash + ':gun', pool.length)];
}
