/**
 * Rallies from net crossings.
 *
 * A rally is the ball going over the net and coming back. That is the rule of
 * the sport, not a statistic about it, and it is what this module implements:
 *
 *   - Project the net line into the image from the court calibration.
 *   - Watch which side of it the ball is on.
 *   - A rally starts at the first crossing of a run of them, minus a lead-in.
 *   - It ends when the crossings stop.
 *
 * The thing this gets right that gap-clustering cannot: a player standing on
 * one side bouncing the ball on the floor produces contacts, sometimes a lot
 * of them, and hit-clustering happily calls that a rally. Here it produces
 * zero crossings and is not a rally, because it never was one.
 *
 * A rally also needs at least TWO crossings -- over and back. One crossing is
 * a serve into the net, a feed, or somebody knocking a ball to the next court.
 *
 * THE HARD PART, stated plainly: "which side of the net" is decided in image
 * space, from the ball's position relative to the projected net line. That is
 * the only frame in which it can be decided at all -- a ball in flight is off
 * the court plane, so the homography cannot place it, and the pipeline is
 * careful everywhere else not to pretend otherwise. The cost is that height
 * and depth look alike from behind a baseline: a lob on the near side rises
 * above the net line in the image without ever crossing it.
 *
 * Two things keep that from inventing rallies. A crossing must clear a
 * deadband either side of the line, so a ball hovering near it does not
 * chatter; and it must STAY on the new side for a minimum dwell, which a lob
 * apex does not. Neither is a fix for a genuinely ambiguous lob -- on a low
 * camera the far court is a few dozen pixels tall and some of them are simply
 * not separable. `crossings` is reported per rally so the ambiguity is
 * visible rather than buried.
 */

import { applyHomography, computeHomography, type Homography } from "./homography";
import { courtFrameFor } from "./shots";
import type { BallTrackPoint } from "./ball";
import type { ClusteredRally } from "./rallies";
import type { CourtCalibration } from "./phase2-types";

export interface NetRallyParams {
  /** Seconds of run-up kept before the first crossing. */
  leadS: number;
  /** Seconds kept after the last crossing. */
  tailS: number;
  /** Longest quiet spell between crossings that is still the same rally. */
  maxGapS: number;
  /** How far past the net line, as a fraction of frame height, counts as "over". */
  bandNorm: number;
  /** How long the ball must stay on the new side for a crossing to count. */
  minDwellS: number;
  /** Crossings a rally needs. Two = over and back. */
  minCrossings: number;
}

export const NET_RALLY_PARAMS: NetRallyParams = {
  leadS: 1.5,
  tailS: 1.5,
  // Pickleball rallies have gaps: a lob hangs, a player retrieves a deep ball.
  // Wider than the hit-clustering gap because a crossing is a rarer event than
  // a contact -- a four-shot rally has four contacts but maybe two crossings.
  //
  // Swept against the 7 labelled rallies on ky-720p: 4s merged adjacent points
  // into one rally (F1 0.571 at IoU 0.3), 2.5-3s separated them (0.625), and
  // below 2s started splitting single rallies. One clip and seven labels is
  // thin evidence -- treat this as a starting point, not a tuned constant.
  maxGapS: 3,
  // ~1% of frame height. Small on purpose: on a low camera the entire far
  // court is ~6% of frame height, so a generous band would swallow it whole.
  bandNorm: 0.010,
  minDwellS: 0.12,
  minCrossings: 2,
};

export interface NetCrossing {
  t: number;
  /** Side entered: -1 near (below the net line), +1 far. */
  into: -1 | 1;
}

export interface NetRally extends ClusteredRally {
  crossings: number;
  firstCrossingS: number;
  lastCrossingS: number;
}

/**
 * The net as a line in image pixels: two endpoints at the sidelines.
 *
 * Taken from the court calibration, so it moves with whatever the user marked
 * or the detector fitted, and needs no separate net-marking step.
 */
/** Net height in feet: 36in at the posts, 34in at centre (USAP). */
const NET_H_POST_FT = 36 / 12;
const NET_H_CENTRE_FT = 34 / 12;

export interface NetBand {
  /** Where the net meets the ground, sideline to sideline. */
  base: [[number, number], [number, number]];
  /** The top of the tape, following the sag: left post, centre, right post. */
  top: [[number, number], [number, number], [number, number]];
}

/**
 * The net as a surface with height, not a line on the floor.
 *
 * This matters for more than drawing. "Which side of the net is the ball on"
 * cannot be answered from image position alone near the net, because from
 * behind a baseline the net stands between the camera and the far court: on
 * this footage the tape is ~73px tall in the image while the entire far court
 * is ~44px, so the net visually covers the whole thing. A ball anywhere in
 * that band is genuinely undecidable from one frame.
 *
 * Treating the band as a deadband makes the crossing test say so. The ball has
 * to clear the whole net -- appear below its base on the near side, or above
 * its top on the far side -- before a side is declared. That is a physical
 * quantity taken from the court's own geometry, not a tuned percentage.
 */
export function netBandImagePx(
  cal: CourtCalibration | null,
  frameWidthPx: number,
  frameHeightPx: number
): NetBand | null {
  const line = netLineImagePx(cal, frameWidthPx, frameHeightPx);
  if (!line) return null;
  const h = courtToImage(cal!);
  if (!h) return null;

  const frame = courtFrameFor(cal!.quadKind);
  const netYUnit = frame.kind === "full" ? 0.5 : frame.kind === "near-half" ? 0 : -7 / 15;

  // Pixels per foot AT THE NET, measured through the homography rather than
  // assumed: perspective makes a foot at the net a different number of pixels
  // from a foot at the near baseline, and using the wrong one puts the tape
  // metres out.
  const oneFootX = 1 / frame.metresX * 0.3048; // court-x units per foot
  const a = applyHomography(h, [0.5, netYUnit]);
  const b = applyHomography(h, [0.5 + oneFootX, netYUnit]);
  const pxPerFt = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!Number.isFinite(pxPerFt) || pxPerFt <= 0) return null;

  // Up in the image is negative y. The posts are taller than the centre, so
  // the tape sags -- drawing it as one straight line puts it above the real
  // tape in the middle, which is exactly where the ball crosses.
  const [l, r] = line;
  const centreX = (l[0] + r[0]) / 2;
  const centreY = (l[1] + r[1]) / 2;
  return {
    base: line,
    top: [
      [l[0], l[1] - NET_H_POST_FT * pxPerFt],
      [centreX, centreY - NET_H_CENTRE_FT * pxPerFt],
      [r[0], r[1] - NET_H_POST_FT * pxPerFt],
    ],
  };
}

/** Court units (unit square) -> image pixels. */
function courtToImage(cal: CourtCalibration): Homography | null {
  const c = cal.cornersImagePx;
  if (!c || cal.confidence <= 0) return null;
  return computeHomography(
    [[0, 0], [1, 0], [0, 1], [1, 1]],
    [c.topLeft, c.topRight, c.bottomLeft, c.bottomRight]
  );
}

export function netLineImagePx(
  cal: CourtCalibration | null,
  frameWidthPx: number,
  frameHeightPx: number
): [[number, number], [number, number]] | null {
  const c = cal?.cornersImagePx;
  if (!c || !cal || cal.confidence <= 0) return null;
  if (!(frameWidthPx > 0) || !(frameHeightPx > 0)) return null;

  // Court units -> image px. The quad's corners map to the unit square, so
  // invert that to go the other way.
  const h: Homography | null = computeHomography(
    [[0, 0], [1, 0], [0, 1], [1, 1]],
    [c.topLeft, c.topRight, c.bottomLeft, c.bottomRight]
  );
  if (!h) return null;

  const frame = courtFrameFor(cal.quadKind);
  // Court y runs 0 at the quad's top edge to 1 at its bottom. courtFrameFor
  // gives the net's y in the same units for each quad kind, so a near-half
  // calibration (net = top edge) and a full one (net = middle) both work.
  const netYUnit = frame.kind === "full" ? 0.5 : frame.kind === "near-half" ? 0 : -7 / 15;
  const a = applyHomography(h, [0, netYUnit]);
  const b = applyHomography(h, [1, netYUnit]);
  if (![a[0], a[1], b[0], b[1]].every(Number.isFinite)) return null;
  return [[a[0], a[1]], [b[0], b[1]]];
}

/**
 * Signed distance from the net line, in fractions of frame height.
 *
 * Negative = the camera's side of the net (near court), positive = far side.
 * Measured vertically at the ball's own x rather than perpendicular to the
 * line, because the net line is near-horizontal in this camera position and
 * vertical offset is what "over the net" means in the image.
 */
export function sideOfNet(
  pt: { x: number; y: number },
  net: [[number, number], [number, number]],
  frameWidthPx: number,
  frameHeightPx: number
): number {
  const px = pt.x * frameWidthPx;
  const py = pt.y * frameHeightPx;
  const [[ax, ay], [bx, by]] = net;
  const dx = bx - ax;
  // A vertical net line means the camera is side-on; fall back to the
  // perpendicular test rather than dividing by ~0.
  if (Math.abs(dx) < 1e-6) {
    return ((px - ax) / Math.max(1e-6, frameWidthPx));
  }
  const netYAtX = ay + ((by - ay) * (px - ax)) / dx;
  return (netYAtX - py) / frameHeightPx; // above the line (smaller y) => positive => far side
}

/** Every confirmed crossing of the net, in time order. */
export function detectNetCrossings(
  points: BallTrackPoint[],
  cal: CourtCalibration | null,
  frameWidthPx: number,
  frameHeightPx: number,
  params: NetRallyParams = NET_RALLY_PARAMS
): {
  crossings: NetCrossing[];
  net: [[number, number], [number, number]] | null;
  band: NetBand | null;
} {
  const band = netBandImagePx(cal, frameWidthPx, frameHeightPx);
  const net = band?.base ?? netLineImagePx(cal, frameWidthPx, frameHeightPx);
  if (!net) return { crossings: [], net: null, band: null };

  /** Height of the tape at this x, in fractions of frame height. */
  const bandHeightAt = (px: number): number => {
    if (!band) return params.bandNorm;
    const [tl, tc, tr] = band.top;
    const [bl, br] = band.base;
    const t = br[0] === bl[0] ? 0.5 : (px - bl[0]) / (br[0] - bl[0]);
    // Quadratic through the three tape points reproduces the sag.
    const topY = t < 0.5
      ? tl[1] + (tc[1] - tl[1]) * Math.max(0, Math.min(1, t * 2))
      : tc[1] + (tr[1] - tc[1]) * Math.max(0, Math.min(1, (t - 0.5) * 2));
    const baseY = bl[1] + (br[1] - bl[1]) * Math.max(0, Math.min(1, t));
    return Math.max(params.bandNorm, Math.abs(baseY - topY) / frameHeightPx);
  };

  const crossings: NetCrossing[] = [];
  let side: -1 | 1 | 0 = 0;        // confirmed side
  let pending: -1 | 1 | 0 = 0;     // side seen but not yet held long enough
  let pendingSince = 0;

  for (const p of points) {
    if (p.interpolated) continue;  // only real observations decide a crossing
    const d = sideOfNet(p, net, frameWidthPx, frameHeightPx);
    // The ball has to clear the whole net, not merely the line on the floor.
    // Below the base by any margin is the near side; the far side requires
    // being above the tape, because everything between is behind the net from
    // this camera and cannot be assigned to a side at all.
    const height = bandHeightAt(p.x * frameWidthPx);
    const nearThresh = params.bandNorm;
    const farThresh = height;
    if (d > 0 ? d < farThresh : -d < nearThresh) { pending = 0; continue; }
    const now: -1 | 1 = d > 0 ? 1 : -1;

    if (now === side) { pending = 0; continue; }
    if (now !== pending) { pending = now; pendingSince = p.t; continue; }
    if (p.t - pendingSince < params.minDwellS) continue;

    // Held the new side long enough to be real.
    if (side !== 0) crossings.push({ t: pendingSince, into: now });
    side = now;
    pending = 0;
  }
  return { crossings, net, band };
}

/**
 * Group crossings into rallies.
 *
 * The boundaries are the crossings themselves, padded: play starts before the
 * ball first goes over (the serve motion) and continues briefly after it last
 * comes back (the point being conceded, the ball rolling out).
 */
/** A ball that went over once and never came back. Not a rally; still a point. */
export interface DeadBall {
  t: number;
  /** Which way it went, so a serve into the net reads differently from a putaway. */
  into: -1 | 1;
}

export function clusterRalliesFromNetCrossings(
  crossings: NetCrossing[],
  durationSeconds: number,
  params: NetRallyParams = NET_RALLY_PARAMS
): NetRally[] {
  return segmentNetCrossings(crossings, durationSeconds, params).rallies;
}

/**
 * Rallies, and the one-way crossings that are not rallies.
 *
 * A serve into the net produces no return crossing, so the two-crossing rule
 * correctly refuses to call it a rally -- verified against a real clip where a
 * labelled "rally" turned out to be exactly that, and the segmenter was right
 * where the label was wrong.
 *
 * But silently dropping them loses something worth knowing. A fault is a point
 * conceded, and "three serves into the net" is a coachable fact that no rally
 * count will ever contain. So they come back separately rather than being
 * thrown away.
 */
export function segmentNetCrossings(
  crossings: NetCrossing[],
  durationSeconds: number,
  params: NetRallyParams = NET_RALLY_PARAMS
): { rallies: NetRally[]; deadBalls: DeadBall[] } {
  if (crossings.length === 0) return { rallies: [], deadBalls: [] };

  const groups: NetCrossing[][] = [[crossings[0]]];
  for (let i = 1; i < crossings.length; i++) {
    const g = groups[groups.length - 1];
    if (crossings[i].t - g[g.length - 1].t > params.maxGapS) groups.push([crossings[i]]);
    else g.push(crossings[i]);
  }

  const out: NetRally[] = [];
  const deadBalls: DeadBall[] = [];
  for (const g of groups) {
    // Over and back, or it was not a rally. One crossing is a serve into the
    // net, a feed, or a ball knocked to the next court.
    if (g.length < params.minCrossings) {
      for (const c of g) deadBalls.push({ t: c.t, into: c.into });
      continue;
    }
    const first = g[0].t;
    const last = g[g.length - 1].t;
    out.push({
      idx: out.length + 1,
      startS: Math.max(0, first - params.leadS),
      endS: Math.min(durationSeconds, last + params.tailS),
      contacts: g.map((c) => c.t),
      crossings: g.length,
      firstCrossingS: first,
      lastCrossingS: last,
    });
  }
  return { rallies: out, deadBalls };
}


/**
 * On by default. `RALLY_SEGMENTER=hits` or `net_rallies=off` turns it off and
 * falls back to the older segmenters.
 */
export function netRalliesEnabled(): boolean {
  const v = (process.env.NET_RALLIES || "on").toLowerCase();
  return v !== "off" && v !== "0" && v !== "false";
}
