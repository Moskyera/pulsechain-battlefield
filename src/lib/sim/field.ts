/**
 * The bridge between the data layer and the renderer.
 *
 * Swaps can arrive several per second. Pushing each one through React state
 * would re-render the HUD on every trade and stutter the canvas, so live combat
 * travels through this plain mutable module instead: the data engine writes,
 * the R3F frame loop reads and drains. React state is reserved for things a
 * human actually reads (the killfeed, the stat panels), which update far less
 * often.
 *
 * Nothing in here generates data. Every value is written by the engine from a
 * real swap, a real reserve read, or a real DexScreener quote.
 */

import type { RealSwap } from '../data/types';

export interface FieldState {
  /** Front-line position, -1 (bears at the green base) .. +1 (bulls at the red base). */
  frontLineTarget: number;
  /**
   * Accumulated shove from large trades, consumed by the renderer each frame.
   * Sized by real price impact (swap USD / pool liquidity USD).
   */
  impulse: number;
  /** Unit counts, derived from the quote-side and base-side reserves. */
  greenUnits: number;
  redUnits: number;
  /** USD value backing each wall, straight from on-chain reserves. */
  greenStrengthUsd: number;
  redStrengthUsd: number;
  /**
   * Heavy weapons dug in behind each army, one per tank-or-larger trade
   * observed for that side in the current pressure window. Real activity, so a
   * side that is seeing big money visibly masses artillery.
   */
  greenHeavy: number;
  redHeavy: number;
  /** True once reserves and a price have both landed. */
  hasData: boolean;
  /** Render settings, mirrored here so the frame loop needn't touch the store. */
  intense: boolean;
  lowPower: boolean;
  /** Camera shake budget, added to by nuke-tier trades. */
  shake: number;
}

export const field: FieldState = {
  frontLineTarget: 0,
  impulse: 0,
  greenUnits: 0,
  redUnits: 0,
  greenStrengthUsd: 0,
  redStrengthUsd: 0,
  greenHeavy: 0,
  redHeavy: 0,
  hasData: false,
  intense: false,
  lowPower: false,
  shake: 0,
};

/**
 * Bounded queue of real swaps awaiting a unit on the field.
 *
 * Bounded because a burst (or a tab returning from the background) must not
 * spawn a thousand simultaneous explosions. When it overflows we keep the
 * newest and the largest — losing a $3 trade off the back of a stampede is
 * a rendering concession, and it is reported rather than hidden.
 */
class SwapQueue {
  private items: RealSwap[] = [];
  private droppedCount = 0;

  constructor(private readonly capacity: number) {}

  push(swap: RealSwap): void {
    if (this.items.length >= this.capacity) {
      // Evict the smallest pending trade so whales always make it to the field.
      let smallestIdx = 0;
      let smallestUsd = Number.POSITIVE_INFINITY;
      for (let i = 0; i < this.items.length; i++) {
        const usd = this.items[i].usd ?? 0;
        if (usd < smallestUsd) {
          smallestUsd = usd;
          smallestIdx = i;
        }
      }
      if ((swap.usd ?? 0) <= smallestUsd) {
        this.droppedCount++;
        return;
      }
      this.items.splice(smallestIdx, 1);
      this.droppedCount++;
    }
    this.items.push(swap);
  }

  /** Take up to `max` queued swaps, largest first so the big ones never wait. */
  drain(max: number): RealSwap[] {
    if (this.items.length === 0) return [];
    if (this.items.length <= max) {
      const out = this.items;
      this.items = [];
      return out;
    }
    this.items.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
    return this.items.splice(0, max);
  }

  get pending(): number {
    return this.items.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  clear(): void {
    this.items = [];
    this.droppedCount = 0;
  }
}

export const swapQueue = new SwapQueue(160);

/** Reset field state when the user switches battlefields. */
export function resetField(): void {
  field.frontLineTarget = 0;
  field.impulse = 0;
  field.greenUnits = 0;
  field.redUnits = 0;
  field.greenStrengthUsd = 0;
  field.redStrengthUsd = 0;
  field.greenHeavy = 0;
  field.redHeavy = 0;
  field.hasData = false;
  field.shake = 0;
  swapQueue.clear();
}
