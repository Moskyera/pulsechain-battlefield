/**
 * Combat system: turns real swaps into ordnance.
 *
 * Fixed-capacity object pools, updated in place from the R3F frame loop. No
 * allocation per projectile, no garbage churn at 60fps.
 *
 * Every trajectory is a deterministic function of the transaction hash — the
 * same trade produces the same arc on every machine and every reload. The word
 * `random` does not appear in this file for a reason.
 *
 * Trade size decides how the attack looks, and where it comes from:
 *
 *   infantry   a rifleman on the line fires a tracer
 *   tank       one of the standing tanks fires a shell
 *   artillery  one of the standing rocket launchers fires
 *   nuke       a launcher sends a heavy missile, with flash and shake
 *
 * Anything above infantry is fired by a gun that is *already on the field* —
 * see `sim/battery`. The round leaves that piece's muzzle and that piece takes
 * the recoil. Nothing is conjured into existence to fire a shot.
 */

import { hashSigned, hashUnitSalted } from '../util/hash';
import type { RealSwap, Side, UnitTier } from '../data/types';
import { FIELD_HALF_Z, GREEN_BASE_X, RED_BASE_X, frontLineToX } from './layout';
import { batteryPlacement, pieceForTrade } from './battery';

export interface TierProfile {
  /** World units per second. */
  speed: number;
  /** Peak height of the ballistic arc. */
  arc: number;
  /** Explosion radius at full expansion. */
  blast: number;
  /** Explosion lifetime, seconds. */
  blastDuration: number;
  /** Projectile render scale. */
  size: number;
  /** Camera shake contribution on impact. */
  shake: number;
  /** How far behind the front line this tier fires from. */
  standoff: number;
  /** Whether a vehicle appears to fire it. */
  vehicle: boolean;
}

export const TIER_PROFILE: Record<UnitTier, TierProfile> = {
  infantry: {
    speed: 48,
    arc: 1.2,
    blast: 1.3,
    blastDuration: 0.4,
    size: 0.22,
    shake: 0,
    standoff: 4,
    vehicle: false,
  },
  tank: {
    speed: 38,
    arc: 4,
    blast: 2.8,
    blastDuration: 0.75,
    size: 0.85,
    shake: 0.06,
    standoff: 9,
    vehicle: true,
  },
  artillery: {
    speed: 28,
    arc: 11,
    blast: 5.2,
    blastDuration: 1.25,
    size: 1.25,
    shake: 0.2,
    standoff: 15,
    vehicle: true,
  },
  nuke: {
    speed: 21,
    arc: 20,
    blast: 11,
    blastDuration: 2.4,
    size: 2.1,
    shake: 1,
    standoff: 22,
    vehicle: true,
  },
};

export interface Projectile {
  active: boolean;
  side: Side;
  tier: UnitTier;
  t: number;
  duration: number;
  sx: number;
  sy: number;
  sz: number;
  ex: number;
  ey: number;
  ez: number;
  arc: number;
  size: number;
  usd: number;
  swapId: string;
}

export interface Explosion {
  active: boolean;
  side: Side;
  tier: UnitTier;
  t: number;
  duration: number;
  x: number;
  y: number;
  z: number;
  radius: number;
}

export interface ImpactEvent {
  tier: UnitTier;
  /** The side that FIRED this round. Its casualties land on the other side. */
  side: Side;
  usd: number;
  shake: number;
  /** Where it landed, so the infantry and the ground can react to it. */
  x: number;
  z: number;
  radius: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export class CombatSystem {
  readonly projectiles: Projectile[];
  readonly explosions: Explosion[];

  /** Screen flash intensity, driven by nuke-tier impacts. Decays each frame. */
  flash = 0;
  /** Camera shake energy, decays each frame. */
  shake = 0;
  /**
   * Which standing gun fired on the most recent `spawn`, so the renderer can
   * recoil that specific piece. Cleared by the caller once consumed.
   */
  firedPiece: { side: Side; index: number } | null = null;

  constructor(
    readonly projectileCapacity: number,
    readonly explosionCapacity: number,
  ) {
    this.projectiles = Array.from({ length: projectileCapacity }, () => makeProjectile());
    this.explosions = Array.from({ length: explosionCapacity }, () => makeExplosion());
  }

  /**
   * Launch a real swap at the enemy.
   *
   * Green (buys) fire from the left, red (sells) from the right. The firing
   * position sits `standoff` units behind the front line on the attacker's
   * side — clamped so it never ends up inside enemy territory or behind its
   * own base, which is what keeps the staging believable as the line moves.
   *
   * Impact lands past the line, deeper for larger trades: a whale hits further
   * into the opposing camp.
   */
  spawn(swap: RealSwap, frontLine: number): boolean {
    const slot = this.projectiles.find((p) => !p.active);
    if (!slot) return false;

    const profile = TIER_PROFILE[swap.tier];
    const isBuy = swap.side === 'buy';
    const dir = isBuy ? 1 : -1; // direction of fire, along X

    const frontX = frontLineToX(frontLine);
    const ownBaseX = isBuy ? GREEN_BASE_X : RED_BASE_X;

    // Deterministic per-transaction variation.
    const lane = hashSigned(swap.txHash) * FIELD_HALF_Z * 0.8;
    const laneJitter = hashSigned(swap.txHash + ':lane') * 2.5;
    const standoffJitter = hashUnitSalted(swap.txHash, 5) * 4;

    let sx: number;
    let sy: number;
    let sz: number;

    if (profile.vehicle) {
      // Fired by a gun that is actually standing on the field. The round leaves
      // that piece's muzzle, and the piece itself takes the recoil.
      const index = pieceForTrade(swap.txHash, swap.tier !== 'tank');
      const placement = batteryPlacement(index, swap.side, frontLine);
      sx = placement.muzzleX;
      sy = placement.muzzleY;
      sz = placement.z;
      this.firedPiece = { side: swap.side, index };
    } else {
      // Small-arms fire comes from the infantry line, not from the battery.
      const standoff = profile.standoff + standoffJitter;
      const rawX = frontX - dir * standoff;
      sx = isBuy ? clamp(rawX, ownBaseX + 3, frontX - 2) : clamp(rawX, frontX + 2, ownBaseX - 3);
      sy = 1.05;
      sz = lane;
    }

    // Rounds land *inside enemy ground*, never short of the line: the impact
    // point is a fraction of the way from the front line to the enemy base,
    // and bigger trades drive deeper into their camp.
    const enemyBaseX = isBuy ? RED_BASE_X : GREEN_BASE_X;
    const depthToBase = Math.abs(enemyBaseX - frontX);
    const sizeFactor = clamp(Math.log10(Math.max(10, swap.usd ?? 10)) / 5, 0, 1);
    const depthBias = 0.75 + hashUnitSalted(swap.txHash, 2) * 0.5;
    const penetrationFrac = clamp((0.22 + 0.6 * sizeFactor) * depthBias, 0.15, 0.92);

    const ex = frontX + dir * depthToBase * penetrationFrac;
    const ez = lane + laneJitter;
    const ey = 0.4;

    const dist = Math.hypot(ex - sx, ez - sz);
    slot.active = true;
    slot.side = swap.side;
    slot.tier = swap.tier;
    slot.t = 0;
    slot.duration = Math.max(0.22, dist / profile.speed);
    slot.sx = sx;
    slot.sy = sy;
    slot.sz = sz;
    slot.ex = ex;
    slot.ey = ey;
    slot.ez = ez;
    slot.arc = profile.arc * (0.75 + hashUnitSalted(swap.txHash, 4) * 0.5);
    slot.size = profile.size;
    slot.usd = swap.usd ?? 0;
    slot.swapId = swap.id;

    return true;
  }

  /**
   * Advance every projectile, vehicle and explosion.
   * Returns the impacts that happened this frame so the caller can play sound.
   */
  update(dt: number, impacts: ImpactEvent[]): void {
    impacts.length = 0;

    for (const p of this.projectiles) {
      if (!p.active) continue;
      p.t += dt / p.duration;
      if (p.t >= 1) {
        p.active = false;
        this.detonate(p, impacts);
      }
    }

    for (const e of this.explosions) {
      if (!e.active) continue;
      e.t += dt / e.duration;
      if (e.t >= 1) e.active = false;
    }

    // Decay transient camera effects.
    this.shake = Math.max(0, this.shake - dt * 1.6);
    this.flash = Math.max(0, this.flash - dt * 2.6);
  }

  private detonate(p: Projectile, impacts: ImpactEvent[]): void {
    const profile = TIER_PROFILE[p.tier];

    let slot = this.explosions.find((e) => !e.active);
    if (!slot) {
      slot = this.explosions.reduce((a, b) => (a.t > b.t ? a : b));
    }
    slot.active = true;
    slot.side = p.side;
    slot.tier = p.tier;
    slot.t = 0;
    slot.duration = profile.blastDuration;
    slot.x = p.ex;
    slot.y = p.ey + 0.3;
    slot.z = p.ez;
    slot.radius = profile.blast;

    this.shake = Math.min(2.5, this.shake + profile.shake);
    if (p.tier === 'nuke') this.flash = Math.min(1, this.flash + 0.85);

    impacts.push({
      tier: p.tier,
      side: p.side,
      usd: p.usd,
      shake: profile.shake,
      x: p.ex,
      z: p.ez,
      radius: profile.blast,
    });
  }

  /** Current world position of a projectile along its ballistic arc. */
  positionOf(p: Projectile, out: { x: number; y: number; z: number }): void {
    const t = p.t;
    out.x = p.sx + (p.ex - p.sx) * t;
    out.z = p.sz + (p.ez - p.sz) * t;
    // Parabola peaking at t=0.5.
    out.y = p.sy + (p.ey - p.sy) * t + p.arc * 4 * t * (1 - t);
  }

  get activeProjectiles(): number {
    let n = 0;
    for (const p of this.projectiles) if (p.active) n++;
    return n;
  }

  get activeExplosions(): number {
    let n = 0;
    for (const e of this.explosions) if (e.active) n++;
    return n;
  }


  reset(): void {
    for (const p of this.projectiles) p.active = false;
    for (const e of this.explosions) e.active = false;
    this.shake = 0;
    this.flash = 0;
  }
}

function makeProjectile(): Projectile {
  return {
    active: false,
    side: 'buy',
    tier: 'infantry',
    t: 0,
    duration: 1,
    sx: 0,
    sy: 0,
    sz: 0,
    ex: 0,
    ey: 0,
    ez: 0,
    arc: 0,
    size: 1,
    usd: 0,
    swapId: '',
  };
}

function makeExplosion(): Explosion {
  return {
    active: false,
    side: 'buy',
    tier: 'infantry',
    t: 0,
    duration: 1,
    x: 0,
    y: 0,
    z: 0,
    radius: 1,
  };
}

