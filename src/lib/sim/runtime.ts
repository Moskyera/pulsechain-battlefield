'use client';

/**
 * Per-frame render state shared across scene components.
 *
 * A module singleton rather than React context: there is exactly one
 * battlefield at a time, the frame loop must read it without a subscription,
 * and it survives React StrictMode's double-mount in development without
 * allocating two combat pools.
 */

import { CombatSystem } from './combat';
import { BATTERY } from './battery';
import type { Side } from '../data/types';

/**
 * A real detonation, kept around after its fireball is gone.
 *
 * The explosion pool recycles its slots within a second, but two things need to
 * outlive that: the infantry caught in the blast, and the ground it tore up.
 * Both read this ring buffer at their own pace, so it records *where* every real
 * trade landed rather than only that it landed.
 */
export interface BlastRecord {
  x: number;
  z: number;
  radius: number;
  /** The side that fired. Casualties belong to the other one. */
  side: Side;
  /** `runtime.elapsed` at detonation. */
  at: number;
  /**
   * True for a knock-on blast, such as a gun cooking off after a direct hit.
   * The gun line ignores these, so one destroyed piece can never chain into
   * wiping out the battery beside it.
   */
  secondary: boolean;
}

const BLAST_CAPACITY = 64;

function emptyBlasts(): BlastRecord[] {
  return Array.from({ length: BLAST_CAPACITY }, () => ({
    x: 0,
    z: 0,
    radius: 0,
    side: 'buy' as Side,
    at: -1,
    secondary: false,
  }));
}

export const runtime = {
  /** Pools are allocated at the high-quality ceiling; low-power mode simply uses less. */
  combat: new CombatSystem(240, 100),
  /** Eased front-line position, -1..1. Chases `field.frontLineTarget`. */
  frontLine: 0,
  frontLineVelocity: 0,
  /** Seconds since the scene mounted, used for idle animation. */
  elapsed: 0,
  /** Trades spawned this session, for the on-screen render counter. */
  spawned: 0,
  /**
   * `runtime.elapsed` at which each *individual* gun last fired, indexed by its
   * position in the battery. Only the piece that actually took the shot
   * recoils, which is what makes the standing line read as the thing firing.
   */
  batteryFire: {
    buy: new Float32Array(BATTERY.length).fill(-99),
    sell: new Float32Array(BATTERY.length).fill(-99),
  },

  /** Ring buffer of real detonations. See BlastRecord. */
  blasts: emptyBlasts(),
  /** Total blasts ever recorded. Consumers keep their own cursor against it. */
  blastSeq: 0,
};

/** Called by the combat loop the moment a real round detonates. */
export function recordBlast(
  x: number,
  z: number,
  radius: number,
  side: Side,
  secondary = false,
): void {
  const slot = runtime.blasts[runtime.blastSeq % BLAST_CAPACITY];
  slot.x = x;
  slot.z = z;
  slot.radius = radius;
  slot.side = side;
  slot.at = runtime.elapsed;
  slot.secondary = secondary;
  runtime.blastSeq++;
}

/**
 * Walks the blasts a consumer has not seen yet, oldest first.
 *
 * Returns the new cursor. If a consumer falls further behind than the buffer is
 * long (a nuke storm while the tab was hidden), the overwritten ones are simply
 * skipped rather than replayed as stale events.
 */
export function drainBlasts(cursor: number, fn: (b: BlastRecord) => void): number {
  const from = Math.max(cursor, runtime.blastSeq - BLAST_CAPACITY);
  for (let i = from; i < runtime.blastSeq; i++) {
    fn(runtime.blasts[i % BLAST_CAPACITY]);
  }
  return runtime.blastSeq;
}

export function resetRuntime(): void {
  runtime.combat.reset();
  for (const b of runtime.blasts) b.at = -1;
  runtime.blastSeq = 0;
  runtime.batteryFire.buy.fill(-99);
  runtime.batteryFire.sell.fill(-99);
  runtime.frontLine = 0;
  runtime.frontLineVelocity = 0;
  runtime.spawned = 0;
}
