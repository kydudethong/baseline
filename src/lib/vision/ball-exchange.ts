/**
 * Is the ball being exchanged across the net, or bounced on one side?
 *
 * Ky's rule, in his words: if there are contacts from both sides and the ball
 * is changing trajectory side to side at the net, a rally is going on; if the
 * ball is bouncing up and down on one side, the rally is over and the player
 * is just bouncing the ball.
 *
 * Everything already in the pipeline answers the FIRST half. Contacts get a
 * side from the striker's player box (rallies-contact.ts requires both sides;
 * rally-keepalive.ts extends only while sides alternate). Nothing answered the
 * second half from the ball itself, and the striker's side cannot: a player
 * bouncing a ball at the net has an opponent standing a few feet away on the
 * other side, so nearest-player attribution can alternate across a sequence
 * where only one person ever touched the ball. This module asks the ball.
 *
 * GEOMETRY, and why the obvious test is backwards here. sideOfNet() measures
 * signed distance from the net line VERTICALLY in the image (negative = the
 * camera's side), because the camera sits behind the near baseline and the net
 * images as a near-horizontal line. So "toward and away from the net" and "up
 * and down in the image" are the SAME axis. A ball bounced on the floor does
 * not sit still on that axis — it swings a long way along it, because the
 * floor images far from the net and the top of the bounce images close to it.
 * A kitchen dink, meanwhile, barely moves along it at all: both kitchens
 * compress into the net band from this angle, which is the whole reason
 * rally-keepalive.ts exists.
 *
 * That inversion is what makes the test safe. The bounce verdict requires the
 * ball to be well CLEAR of the net for the entire leg and to reverse along the
 * net axis. A dink exchange sitting inside the band fails the clearance test
 * and comes back "unclear", never "bounce" — so this cannot re-break the
 * kitchen case that keep-alive was built to fix.
 *
 * Every verdict here is conservative by construction: callers act on "crossed"
 * and "bounce", and treat "unclear" as no evidence either way. Sparse ball
 * tracking (this footage sees the ball in roughly a quarter of frames) makes
 * "unclear" the common answer, and that is correct — an absent measurement
 * must not become a claim.
 */
import type { BallBounce, BallTrackPoint } from "./ball";

export type PairKind = "crossed" | "same-side-bounce" | "unclear";

export interface ExchangeParams {
  /**
   * Inside this distance of the net line the ball has no side at all. The net
   * tape images ~73px tall while the whole far court is ~44px, so a ball in
   * the band genuinely cannot be assigned a side (see rallies-net.ts).
   */
  deadbandNorm: number;
  /** Fewer real points than this between two contacts and nothing is claimed. */
  minPoints: number;
  /**
   * For a bounce, the ball must stay at least this far from the net across the
   * WHOLE leg. This is the guard that keeps kitchen dinks out of the bounce
   * verdict: they never get this far from the net.
   */
  minSideClearanceNorm: number;
  /** And it must swing at least this far along the net axis, and come back. */
  minBounceSwingNorm: number;
}

export const EXCHANGE_PARAMS: ExchangeParams = {
  deadbandNorm: 0.02,
  minPoints: 4,
  // Deliberately well outside the net band. A ball this far from the net is
  // not in a kitchen exchange.
  minSideClearanceNorm: 0.08,
  minBounceSwingNorm: 0.04,
};

/**
 * Signed distance from the net for one ball point, or null when it cannot be
 * computed (no calibration, ball not seen). Supplied by the caller so this
 * module needs nothing from the court machinery and stays testable with plain
 * numbers.
 */
export type NetDistanceFn = (p: BallTrackPoint) => number | null;

/**
 * What the ball did between two consecutive contacts.
 *
 * Only real observations count. Interpolated points are filled in BETWEEN
 * detections, so a run of them can manufacture a smooth arc across exactly the
 * gap where the evidence is missing — which is where a false verdict would
 * come from.
 */
export function classifyBetween(
  points: BallTrackPoint[],
  tA: number,
  tB: number,
  netDistance: NetDistanceFn,
  params: ExchangeParams = EXCHANGE_PARAMS
): PairKind {
  if (!(tB > tA)) return "unclear";
  const ds: number[] = [];
  for (const p of points) {
    if (p.t < tA || p.t > tB) continue;
    if (p.interpolated) continue;
    const d = netDistance(p);
    if (d === null || !Number.isFinite(d)) continue;
    ds.push(d);
  }
  if (ds.length < params.minPoints) return "unclear";

  // Crossed: seen clearly on both sides somewhere in the leg. Order does not
  // matter — one crossing is enough to know the ball went over.
  const sawFar = ds.some((d) => d >= params.deadbandNorm);
  const sawNear = ds.some((d) => d <= -params.deadbandNorm);
  if (sawFar && sawNear) return "crossed";

  // Otherwise: did it stay clear of the net on ONE side and swing back and
  // forth along the net axis? That is a bounce.
  const sign = ds[0] >= 0 ? 1 : -1;
  if (!ds.every((d) => (d >= 0 ? 1 : -1) === sign)) return "unclear";
  if (!ds.every((d) => Math.abs(d) >= params.minSideClearanceNorm)) return "unclear";

  const min = Math.min(...ds);
  const max = Math.max(...ds);
  if (max - min < params.minBounceSwingNorm) return "unclear";

  // A swing alone is not a bounce — the ball has to come BACK, or it is just
  // one ball travelling away from the net. Require a genuine turn: an interior
  // extreme, not merely a monotonic run from one end of the range to the other.
  const iMin = ds.indexOf(min);
  const iMax = ds.indexOf(max);
  const turned = (iMin > 0 && iMin < ds.length - 1) || (iMax > 0 && iMax < ds.length - 1);
  return turned ? "same-side-bounce" : "unclear";
}

export interface BounceTrimStats {
  /** Groups that were never a rally — every leg was one-side bouncing. */
  dropped: number;
  /** Rallies whose bouncing tail was cut off, and by how much in total. */
  trimmed: number;
  trimmedSeconds: number;
}

export function newBounceTrimStats(): BounceTrimStats {
  return { dropped: 0, trimmed: 0, trimmedSeconds: 0 };
}

interface TrimmableRally {
  startS: number;
  endS: number;
  contacts: number[];
}

/**
 * Apply the rule to already-clustered rallies.
 *
 * Two actions, both requiring positive bounce evidence:
 *
 *   DROP  a rally whose every judgeable leg was one-side bouncing and none of
 *         which crossed. That was somebody bouncing a ball, not a point.
 *   TRIM  the tail of a rally back to its last exchange, when the contacts
 *         after it are bouncing. "The rally is over, the player is just
 *         bouncing the ball up and down" — so the rally should end there.
 *
 * A rally with no judgeable legs at all is left exactly as it was. On this
 * footage that is the common case, and doing nothing is the honest response to
 * having no evidence.
 */
export function applyBounceRule<T extends TrimmableRally>(
  rallies: T[],
  classify: (tA: number, tB: number) => PairKind,
  tailS: number,
  stats: BounceTrimStats = newBounceTrimStats()
): { rallies: T[]; stats: BounceTrimStats } {
  const out: T[] = [];

  for (const rally of rallies) {
    const cs = [...rally.contacts].sort((a, b) => a - b);
    if (cs.length < 2) { out.push(rally); continue; }

    const kinds: PairKind[] = [];
    for (let i = 1; i < cs.length; i++) kinds.push(classify(cs[i - 1], cs[i]));

    const bounces = kinds.filter((k) => k === "same-side-bounce").length;
    const crossings = kinds.filter((k) => k === "crossed").length;
    if (bounces === 0) { out.push(rally); continue; }

    if (crossings === 0) {
      // Nothing here ever went over the net, and something here was bouncing.
      stats.dropped += 1;
      continue;
    }

    // Cut back to the last leg that actually crossed.
    const lastCrossing = kinds.lastIndexOf("crossed");
    const trailingBounce = kinds.slice(lastCrossing + 1).includes("same-side-bounce");
    if (!trailingBounce) { out.push(rally); continue; }

    const lastLiveContact = cs[lastCrossing + 1];
    // The first contact of the bouncing. The rally ends BEFORE it: the tail is
    // padding on the end of play, not a window wide enough to re-admit the
    // very contacts this rule just rejected.
    const firstBounceContact = cs[lastCrossing + 2];
    const newEnd = Math.min(
      rally.endS,
      lastLiveContact + tailS,
      firstBounceContact !== undefined ? firstBounceContact - 0.05 : Infinity
    );
    if (newEnd < rally.endS - 1e-6) {
      stats.trimmed += 1;
      stats.trimmedSeconds += rally.endS - newEnd;
    }
    out.push({
      ...rally,
      endS: Math.round(newEnd * 1000) / 1000,
      contacts: cs.filter((t) => t <= lastLiveContact),
    });
  }

  stats.trimmedSeconds = Math.round(stats.trimmedSeconds * 10) / 10;
  return { rallies: out, stats };
}

/**
 * On by default, and safe to leave on: it can only ever shorten or remove a
 * rally, and only on positive evidence that the ball was bouncing on one side.
 * Off via BALL_BOUNCE_RULE=off if it ever costs more than it saves.
 */
export function bounceRuleEnabled(): boolean {
  const v = (process.env.BALL_BOUNCE_RULE || "on").toLowerCase();
  return v !== "off" && v !== "0" && v !== "false";
}

/* ------------------------------------------------------------------------ */
/* The double bounce — the actual rule of the game                           */
/* ------------------------------------------------------------------------ */

/**
 * Where a rally ended because the ball bounced twice on one side.
 *
 * This is not a heuristic like the swing test above; it is the rule of
 * pickleball. If the ball lands on one side and lands again on that same side
 * without anybody hitting it in between, the point is over at the second
 * bounce. Nothing after it belongs to the rally.
 *
 * It runs BEFORE the trajectory heuristic because it is the stronger evidence:
 * it needs no thresholds beyond the net deadband, and its answer is a fact
 * about the game rather than an inference about what the ball looked like.
 * The heuristic still earns its place, because it catches somebody bouncing a
 * ball BETWEEN points, where there are no detected contacts to reason about
 * and often no clean bounces either.
 *
 * Both bounces must be assignable to a side — a bounce inside the net band has
 * no side, and two unplaceable bounces are not evidence of anything. Returns
 * null when there is no double bounce, which on sparse ball tracking is the
 * common answer and the honest one.
 */
export function findDoubleBounceEnd(
  bounces: BallBounce[],
  contactTimes: number[],
  netDistance: (p: { x: number; y: number }) => number | null,
  params: ExchangeParams = EXCHANGE_PARAMS
): { t: number; side: "near" | "far" } | null {
  const placed = bounces
    .map((b) => ({ b, d: netDistance(b) }))
    .filter((e): e is { b: BallBounce; d: number } =>
      e.d !== null && Number.isFinite(e.d) && Math.abs(e.d) >= params.deadbandNorm)
    .sort((a, b) => a.b.t - b.b.t);

  for (let i = 1; i < placed.length; i++) {
    const prev = placed[i - 1], cur = placed[i];
    if ((prev.d >= 0) !== (cur.d >= 0)) continue;          // it went over — legal
    // Anybody hit it in between? Then the second bounce is a new ball.
    const struckBetween = contactTimes.some((t) => t > prev.b.t && t < cur.b.t);
    if (struckBetween) continue;
    return { t: cur.b.t, side: cur.d >= 0 ? "far" : "near" };
  }
  return null;
}

export interface DoubleBounceStats {
  ended: number;
  trimmedSeconds: number;
}

/**
 * Cut each rally at its first double bounce.
 *
 * Only ever shortens. A rally with no double bounce in it is returned
 * untouched, and a double bounce found before the rally's first contact is
 * ignored — that is the previous point's ball still on the floor, not this
 * one's ending.
 */
export function applyDoubleBounceRule<T extends TrimmableRally>(
  rallies: T[],
  bouncesIn: (startS: number, endS: number) => BallBounce[],
  contactTimes: number[],
  netDistance: (p: { x: number; y: number }) => number | null,
  tailS: number,
  params: ExchangeParams = EXCHANGE_PARAMS
): { rallies: T[]; stats: DoubleBounceStats } {
  const stats: DoubleBounceStats = { ended: 0, trimmedSeconds: 0 };
  const out = rallies.map((rally) => {
    const firstContact = rally.contacts.length ? Math.min(...rally.contacts) : rally.startS;
    const hit = findDoubleBounceEnd(
      bouncesIn(rally.startS, rally.endS).filter((b) => b.t > firstContact),
      contactTimes, netDistance, params
    );
    if (!hit) return rally;
    const newEnd = Math.min(rally.endS, hit.t + tailS);
    if (newEnd >= rally.endS - 1e-6) return rally;
    stats.ended += 1;
    stats.trimmedSeconds += rally.endS - newEnd;
    return {
      ...rally,
      endS: Math.round(newEnd * 1000) / 1000,
      contacts: rally.contacts.filter((t) => t <= hit.t),
    };
  });
  stats.trimmedSeconds = Math.round(stats.trimmedSeconds * 10) / 10;
  return { rallies: out, stats };
}
