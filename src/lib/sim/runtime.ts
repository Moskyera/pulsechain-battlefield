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
};

export function resetRuntime(): void {
  runtime.combat.reset();
  runtime.batteryFire.buy.fill(-99);
  runtime.batteryFire.sell.fill(-99);
  runtime.frontLine = 0;
  runtime.frontLineVelocity = 0;
  runtime.spawned = 0;
}
