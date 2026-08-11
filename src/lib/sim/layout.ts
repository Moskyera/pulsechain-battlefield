/** Shared world dimensions. One place so scene and combat never disagree. */

/**
 * Field extents.
 *
 * Tightened once the armies became ~20 properly modelled soldiers rather than
 * a few hundred markers: a smaller field puts the camera close enough to read
 * individual troops and vehicles, which is the whole point of modelling them.
 * It also keeps the fighting inside the clear strip between the left and right
 * HUD columns.
 */
export const FIELD_HALF_X = 42;
export const FIELD_HALF_Z = 23;

/**
 * How far the front line can push toward a base.
 *
 * Kept well short of the base: at full travel the losing side's army — and its
 * whole gun line, which sits up to 24 units further back — would slide out
 * behind the HUD's side panels and simply vanish. The exact position is always
 * reported as a percentage in the force bar, so clamping the *visual* travel
 * costs no information.
 */
export const FRONT_TRAVEL = 0.52;

/** Convert a normalised front-line value (-1..1) into a world X coordinate. */
export function frontLineToX(frontLine: number): number {
  return frontLine * FIELD_HALF_X * FRONT_TRAVEL;
}

export const GREEN_BASE_X = -FIELD_HALF_X - 4;
export const RED_BASE_X = FIELD_HALF_X + 4;

/** Battle-side colours, reused by scene and HUD so they stay in sync. */
export const COLORS = {
  buy: '#22e07a',
  buyDark: '#0b8f47',
  sell: '#ff3b4e',
  sellDark: '#a01020',
  neutral: '#7c8ba1',
  /** Sun-bleached dirt, not void — this is a daylight valley. */
  ground: '#8a8060',
} as const;
