/**
 * Turning a finger on a phone into "that player".
 *
 * Extracted from SetupCanvas so it can be tested at all. Everything else about
 * that screen needs a canvas, a decoded video and a pointer; this is the one
 * part that is arithmetic, and it is the part where being slightly wrong is
 * invisible -- a tolerance too tight means taps that appear to do nothing, one
 * too loose means tapping an opponent and getting your partner.
 */

import { boxRect, type BoxPx } from "./image-space";

export interface TapCandidate {
  /**
   * The detection box as TWO CORNERS, which is what the detector reports.
   *
   * Typed rather than left as four numbers because this file read them as
   * `[x, y, width, height]` -- the shape every drawing API takes -- and the
   * tests built their fixtures the same way, so both agreed and both were
   * wrong. Hit-testing then measured distance to a box stretching from the
   * player to the bottom-right of the frame, which matches almost any tap.
   */
  boxPx: BoxPx;
  /** Where this player's feet are. The seed is stored here, not at the tap. */
  feetPx: [number, number];
}

/**
 * How near a tap must land, as a fraction of the tapped player's box height.
 *
 * IN BODY HEIGHTS, like every other tolerance in this codebase, because a
 * player at the far baseline is a fraction of the size of one near the camera.
 * A fixed pixel radius is generous up close and unusable at range -- which is
 * exactly backwards, since the far player is the harder one to hit.
 *
 * 0.6 is a little over half a body. Measured from the box EDGE rather than its
 * centre, so it is forgiveness around an already-generous target rather than
 * the target itself.
 */
export const TAP_SNAP_HEIGHTS = 0.6;

/** Distance from a point to the nearest edge of a box; 0 when inside it. */
function distanceToBox(p: { x: number; y: number }, box: BoxPx): number {
  const { x, y, width, height } = boxRect(box);
  const dx = Math.max(x - p.x, 0, p.x - (x + width));
  const dy = Math.max(y - p.y, 0, p.y - (y + height));
  return Math.hypot(dx, dy);
}

/**
 * The feet of the player this tap meant, or null if it meant none of them.
 *
 * RETURNS FEET, NOT THE TAP. Somebody aiming at a player on a phone hits their
 * shirt, and the seed has to sit at their feet: feet are the only part of a
 * person on the court plane, and matchTracksToSetup compares against a track's
 * feet with a tolerance of about one body height. A torso is most of a body
 * height away from the ground, so keeping the raw tap would land right at the
 * edge of matching -- sometimes finding the player, sometimes not, depending
 * on how tall they happened to be in frame.
 */
export function nearestPlayerFeet(
  tap: { x: number; y: number },
  players: TapCandidate[],
  toleranceHeights = TAP_SNAP_HEIGHTS
): { x: number; y: number } | null {
  let best: { distance: number; feet: { x: number; y: number } } | null = null;
  for (const p of players) {
    const distance = distanceToBox(tap, p.boxPx);
    const height = boxRect(p.boxPx).height;
    if (distance > height * toleranceHeights) continue;
    // NEAREST WINS, not first. Two players overlapping at the net is the
    // normal case on a doubles court, and iterating in detector order would
    // hand the tap to whichever the model happened to emit first.
    if (!best || distance < best.distance) {
      best = { distance, feet: { x: p.feetPx[0], y: p.feetPx[1] } };
    }
  }
  return best?.feet ?? null;
}

/** Whether two seeds are the same point, so one person cannot be tagged twice. */
export function samePoint(
  a: { x: number; y: number } | null,
  b: { x: number; y: number } | null
): boolean {
  if (!a || !b) return false;
  return Math.hypot(a.x - b.x, a.y - b.y) < 1;
}
