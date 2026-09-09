/**
 * Audio-proposed, vision-confirmed paddle contacts.
 *
 * Audio is the best timing signal available for a paddle strike: a short,
 * sharp transient, accurate to a few tens of milliseconds, and it does not
 * care whether the ball was visible. That matters most exactly where the
 * vision pipeline is weakest -- kitchen exchanges, where the ball sits inside
 * the net band, is small, low-contrast and half the time behind a player.
 *
 * It is also the least discriminating signal available. These clips are shot
 * on courts with other games either side, and a microphone hears all of them.
 * A detector that trusted onsets alone would invent contacts for somebody
 * else's rally and scatter them through the timeline.
 *
 * So audio never decides anything here. It PROPOSES an instant, and the ball's
 * own behaviour at that instant decides:
 *
 *   1. the ball must have been seen either side of the onset,
 *   2. it must have been travelling TOWARD a player who could reach it,
 *   3. its velocity must actually change across the onset.
 *
 * A ball that keeps sailing through an onset was not struck at it; that onset
 * belongs to the next court and is dropped. This is the rule Ky specified, and
 * it is the right one: it trades recall (a contact where the ball was never
 * seen stays lost) for precision (a contact that is reported really happened
 * on this court).
 *
 * Note what the ball evidence does NOT have to include: the moment of contact
 * itself. Points before and after are enough to fit two velocities, which is
 * why this recovers contacts the blind scan misses -- the ball is often lost
 * for the few frames around the strike and visible either side of it.
 *
 * The thresholds are deliberately looser than detectHits()'s. That scan has to
 * survive a whole clip of dead time with nothing vouching for a candidate, so
 * it must be strict. Here audio has already carried the burden of proof, and
 * the vision test is being asked a much narrower question: given that
 * something struck a ball at T, did THIS ball change at T?
 */
import type { BallHit, BallTrackPoint } from "./ball";
import type { PlayerTrack } from "./phase2-types";

export interface AudioOnset {
  timestampSeconds: number;
  strength: number;
}

export interface AudioGateParams {
  /** How far either side of the onset to look for ball evidence. */
  windowS: number;
  /**
   * The span within which the ball's own flight is trustworthy as a witness.
   *
   * windowS says how far to LOOK; this says how far away the evidence can be
   * before it stops meaning much. A ball seen 0.9 s before the sound and 0.9 s
   * after has had nearly two seconds to change direction on its own -- it can
   * bounce, it can arc over under gravity, someone else can hit it -- so a
   * "turn" measured across that span is not evidence of a strike at T. Rather
   * than throw those away, the thresholds scale: the wider the blind span
   * around the onset, the bigger the change has to be before it counts, and
   * the lower the confidence of the contact that results.
   */
  tightSpanS: number;
  /** Minimum real observations needed on each side to fit a velocity. */
  minPointsPerSide: number;
  /**
   * How far apart in time the two points fitting one velocity may be.
   *
   * Without this the "did the ball change" test is close to a no-op. Measured
   * on ky-720p: 21% of the pairs it would otherwise use span more than 0.15 s,
   * and a chord across a gap that long is not a velocity -- it is an average
   * over an arc, whose direction says more about where the gap fell than about
   * the ball. 76 of 100 onsets passed the test with those included, which is
   * not a filter. Same failure the hit detector had with index-based windows.
   */
  maxLegSpanS: number;
  /** Direction change that counts as a strike, in degrees. */
  minTurnDeg: number;
  /**
   * A strike that barely turns the ball must instead change its PACE: a dink
   * absorbs speed, a drive adds it. Either counts.
   */
  minSpeedRatio: number;
  /** How close (image-normalized, scaled by box size) a player must be. */
  reach: number;
  /** Two accepted contacts are never closer together than this. */
  minSpacingS: number;

}

/**
 * A number from the environment, or the default.
 *
 * Only the two window knobs are overridable, and only because they are the
 * ones being tuned: comparing 0.35 against 1.0 on the same clip should be two
 * runs, not two edits and two rebuilds. Everything else stays a constant —
 * a threshold you can change without leaving a trace in the repo is a
 * threshold nobody can explain six weeks later.
 */
function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const AUDIO_GATE_PARAMS: AudioGateParams = {
  // Back to 0.35 s after measuring it. Widening to 1.0 s was tried on
  // ky-720p (100 onsets, the Sept-5 cached track): it accepted exactly the
  // same 8 contacts. Looking further out DID find more ball sightings --
  // "no ball either side" fell 61 to 49 -- but every one of those then failed
  // maxLegSpanS instead, because the extra sightings were too far apart to fit
  // a velocity from. "Too gappy" rose 7 to 17. The onsets moved between
  // rejection buckets and the answer never changed.
  //
  // The binding constraint is the density of the ball track, not the reach of
  // this window. Widen it again only if a re-measure on a denser track shows
  // maxLegSpanS has stopped binding.
  windowS: envNum("AUDIO_WINDOW_S", 0.35),
  tightSpanS: envNum("AUDIO_TIGHT_SPAN_S", 0.35),
  minPointsPerSide: 2,
  maxLegSpanS: 0.15,
  minTurnDeg: 12,
  minSpeedRatio: 1.6,
  reach: 0.18,
  minSpacingS: 0.18,
};

export interface AudioGateStats {
  onsets: number;
  accepted: number;
  rejectedNoBall: number;
  /** Ball seen, but too sparsely either side to fit a velocity worth testing. */
  rejectedGappy: number;
  rejectedNotTowardPlayer: number;
  rejectedNoChange: number;
  rejectedSpacing: number;
}

export function newAudioGateStats(): AudioGateStats {
  return {
    onsets: 0, accepted: 0, rejectedNoBall: 0, rejectedGappy: 0,
    rejectedNotTowardPlayer: 0, rejectedNoChange: 0, rejectedSpacing: 0,
  };
}

type V = { vx: number; vy: number; speed: number };

function velocity(a: BallTrackPoint, b: BallTrackPoint): V | null {
  const dt = b.t - a.t;
  if (!(Math.abs(dt) > 1e-3)) return null;
  const vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
  return { vx, vy, speed: Math.hypot(vx, vy) };
}

function turnDeg(a: V, b: V): number {
  if (a.speed < 1e-6 || b.speed < 1e-6) return 0;
  const cos = Math.min(1, Math.max(-1, (a.vx * b.vx + a.vy * b.vy) / (a.speed * b.speed)));
  return (Math.acos(cos) * 180) / Math.PI;
}

function playerAt(track: PlayerTrack, t: number, toleranceS = 0.4) {
  let best: PlayerTrack["points"][number] | null = null;
  let bestDt = toleranceS;
  for (const p of track.points) {
    const dt = Math.abs(p.timestampSeconds - t);
    if (dt <= bestDt) { bestDt = dt; best = p; }
  }
  return best;
}

/**
 * Where a paddle is, if anything saw one. Falls back to the player's box, so
 * the gate works identically with or without paddle detection -- paddle
 * detection sharpens "toward a player" into "toward the paddle", it is not
 * load-bearing for the rule.
 */
export interface PaddleObservation {
  /**
   * Where this came from. "pose" is an ESTIMATE derived from the swinging
   * arm, not a sighting of a paddle -- see paddle-from-pose.ts. Carried so
   * the debug overlay can draw the two differently: a video that showed an
   * inference and a measurement identically would undo the care taken
   * everywhere else to keep them apart.
   */
  source?: "detected" | "pose";
  /**
   * Which way the paddle points IN THE IMAGE, degrees, 0 = +x, growing
   * clockwise (y is down). This is the long axis only.
   *
   * It is NOT the face angle. Whether the face is open or closed is
   * rotation about this axis, set by forearm pronation, and a 17-point
   * COCO pose model has nothing past the wrist to see it with. Anything
   * claiming an open or closed face needs hand keypoints, an oriented-box
   * detector, the ball's own in/out vectors, or a wrist IMU -- not this.
   */
  angleDeg?: number;
  t: number;
  /** Box centre, image-normalized. */
  x: number;
  y: number;
  /**
   * Box size, image-normalized. The detector always reports one; it is carried
   * so the debug overlay can draw the actual BOX the model found rather than a
   * fixed-radius circle at its centre. A circle looks the same whether the
   * model boxed a paddle or half a court, which defeats the point of drawing
   * it at all. Optional only so a detector that reports a point still works.
   */
  w?: number;
  h?: number;
  playerId: string | null;
  confidence: number;
}

/**
 * How fast this player is moving at t, in their OWN box heights per second.
 *
 * Box height stands in for apparent size, so the same number means the same
 * real speed whether the player is at the near baseline or the far one. Uses
 * the two real samples straddling t rather than a longer window: the thing
 * being detected is the step-and-swing at contact, which is over in a couple
 * of tenths of a second and washes out of any longer average.
 */
export function playerSpeedBoxHeights(track: PlayerTrack, t: number, windowS = 0.35): number | null {
  const near = track.points
    .filter((p) => Math.abs(p.timestampSeconds - t) <= windowS)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);
  if (near.length < 2) return null;
  const a = near[0], b = near[near.length - 1];
  const dt = b.timestampSeconds - a.timestampSeconds;
  if (!(dt > 1e-3)) return null;
  const ax = a.boxImageNorm.x + a.boxImageNorm.width / 2;
  const ay = a.boxImageNorm.y + a.boxImageNorm.height / 2;
  const bx = b.boxImageNorm.x + b.boxImageNorm.width / 2;
  const by = b.boxImageNorm.y + b.boxImageNorm.height / 2;
  const h = Math.max(1e-6, (a.boxImageNorm.height + b.boxImageNorm.height) / 2);
  return Math.hypot(bx - ax, by - ay) / h / dt;
}

/**
 * Where two straight legs meet: the corner the ball turned at.
 *
 * Returns null rather than a number whenever the answer would be untrustworthy,
 * because a bad apex is worse than an honest chord -- it puts a confident
 * marker somewhere the ball demonstrably was not.
 *
 *   near-parallel legs  a glancing contact barely bends the ball, so the lines
 *                       meet a long way off and the intersection is dominated
 *                       by noise in two nearly-identical velocities. Note this
 *                       also catches a PERFECT reversal: in along one line and
 *                       back along a parallel one never intersect, however
 *                       obvious the turn looks to an eye
 *   apex behind or past the sightings
 *                       the corner should sit BETWEEN the last sighting and
 *                       the first; outside that, the legs were not describing
 *                       a single turn
 *   apex far off the chord
 *                       a real strike happens close to the path the ball was
 *                       already on. Metres away means the geometry degenerated
 */
function apexOf(
  a: { x: number; y: number },
  vIn: { vx: number; vy: number },
  b: { x: number; y: number },
  vOut: { vx: number; vy: number }
): { x: number; y: number } | null {
  const cross = vIn.vx * vOut.vy - vIn.vy * vOut.vx;
  // Sin of the angle between the legs, scaled by both speeds. Small means
  // nearly parallel however fast the ball was going.
  const mag = Math.hypot(vIn.vx, vIn.vy) * Math.hypot(vOut.vx, vOut.vy);
  if (mag < 1e-9 || Math.abs(cross) / mag < 0.08) return null;

  const s = ((b.x - a.x) * vOut.vy - (b.y - a.y) * vOut.vx) / cross;
  const p = { x: a.x + vIn.vx * s, y: a.y + vIn.vy * s };

  // The corner has to lie between the two sightings, with a little slack for
  // the fact that neither is exactly at the contact.
  const along = (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y);
  const chordLen2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  if (chordLen2 > 1e-9) {
    const tAlong = along / chordLen2;
    if (tAlong < -0.35 || tAlong > 1.35) return null;
  }

  // And it must be near the path, not out in the car park.
  const chordLen = Math.sqrt(chordLen2);
  const offChord = Math.hypot(p.x - (a.x + (b.x - a.x) * 0.5), p.y - (a.y + (b.y - a.y) * 0.5));
  if (offChord > Math.max(0.12, chordLen)) return null;

  if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return null;
  return { x: Math.round(p.x * 1e5) / 1e5, y: Math.round(p.y * 1e5) / 1e5 };
}

function paddleNear(paddles: PaddleObservation[], t: number, toleranceS: number) {
  let best: PaddleObservation | null = null;
  let bestDt = toleranceS;
  for (const p of paddles) {
    const dt = Math.abs(p.t - t);
    if (dt <= bestDt) { bestDt = dt; best = p; }
  }
  return best;
}

/**
 * Turn audio onsets into contacts, keeping only those the ball agrees with.
 */
export function confirmAudioContacts(input: {
  onsets: AudioOnset[];
  ballPoints: BallTrackPoint[];
  tracks: PlayerTrack[];
  paddles?: PaddleObservation[];
  params?: AudioGateParams;
  stats?: AudioGateStats;
}): BallHit[] {
  const params = input.params ?? AUDIO_GATE_PARAMS;
  const stats = input.stats;
  const observed = input.ballPoints
    .filter((p) => !p.interpolated)
    .sort((a, b) => a.t - b.t);
  const out: BallHit[] = [];
  // Too little ball to fit a velocity either side of anything: every onset
  // would be rejected one at a time below, so say so once and stop.
  //
  // This was briefly relaxed to `=== 0` so that a recovery path could run on
  // sparse clips. That path is gone, and with it the reason to keep looping.
  if (observed.length < params.minPointsPerSide * 2) {
    if (stats) { stats.onsets += input.onsets.length; stats.rejectedNoBall += input.onsets.length; }
    return out;
  }

  for (const onset of [...input.onsets].sort((a, b) => a.timestampSeconds - b.timestampSeconds)) {
    const T = onset.timestampSeconds;
    if (stats) stats.onsets += 1;

    const before = observed.filter((p) => p.t < T && T - p.t <= params.windowS);
    const after = observed.filter((p) => p.t > T && p.t - T <= params.windowS);
    if (before.length < params.minPointsPerSide || after.length < params.minPointsPerSide) {
      // The ball was not seen either side of the sound, so there is nothing to
      // corroborate it with. A sound alone is not a contact -- the courts next
      // door make the same one -- so it is dropped.
      if (stats) stats.rejectedNoBall += 1;
      continue;
    }

    // Velocity immediately before and immediately after — the two points
    // closest to the onset on each side, so a long tail of the previous
    // trajectory cannot wash out the change.
    const inPair: [BallTrackPoint, BallTrackPoint] = [before[before.length - 2], before[before.length - 1]];
    const outPair: [BallTrackPoint, BallTrackPoint] = [after[0], after[1]];
    if (inPair[1].t - inPair[0].t > params.maxLegSpanS || outPair[1].t - outPair[0].t > params.maxLegSpanS) {
      if (stats) stats.rejectedGappy += 1;
      continue;
    }
    const vIn = velocity(inPair[0], inPair[1]);
    const vOut = velocity(outPair[0], outPair[1]);
    if (!vIn || !vOut) { if (stats) stats.rejectedNoBall += 1; continue; }

    // WHERE THE STRIKE HAPPENED. The ball is almost never detected at the
    // instant of contact -- the paddle and the striker's body hide it -- so
    // this has to be reconstructed from the legs either side.
    //
    // Interpolating linearly between the last sighting and the first is the
    // obvious thing and it is wrong in a specific way: the ball TURNS at a
    // contact, that turn is the whole reason this onset was accepted, and a
    // straight line between the two legs cuts the corner. The marker lands
    // out in open court somewhere between the incoming and outgoing paths,
    // which is exactly where the ball never was.
    //
    // The contact is the APEX -- where the two legs, extended, meet. Solve for
    // the intersection of the incoming and outgoing lines.
    const last = before[before.length - 1], first = after[0];
    const span = first.t - last.t;
    const f = span > 1e-6 ? (T - last.t) / span : 0;
    const chord = { x: last.x + (first.x - last.x) * f, y: last.y + (first.y - last.y) * f };
    const ballAt = apexOf(last, vIn, first, vOut) ?? chord;

    // Was it going toward someone who could hit it?
    let hitter: { id: string; feet: { x: number; y: number }; dist: number } | null = null;
    // Tight, not windowS: a paddle box a second away is a different shot.
    const paddle = input.paddles?.length ? paddleNear(input.paddles, T, params.tightSpanS) : null;
    for (const tr of input.tracks) {
      const pl = playerAt(tr, T);
      if (!pl) continue;
      const b = pl.boxImageNorm;
      const target = paddle && paddle.playerId === tr.playerId
        ? { x: paddle.x, y: paddle.y }
        : { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      const reach = Math.max(params.reach, b.height * 0.9);
      const dist = Math.hypot(ballAt.x - target.x, ballAt.y - target.y);
      if (dist > reach) continue;
      // "Toward": the pre-contact velocity has to be closing on them. A ball
      // flying away from a player was not hit by that player, however near.
      const closing = (target.x - last.x) * vIn.vx + (target.y - last.y) * vIn.vy;
      if (closing <= 0) continue;
      if (!hitter || dist < hitter.dist) {
        hitter = { id: tr.playerId, feet: { x: b.x + b.width / 2, y: b.y + b.height }, dist };
      }
    }
    if (!hitter) { if (stats) stats.rejectedNotTowardPlayer += 1; continue; }

    // Did the ball actually change? This is the test that drops the next
    // court's audio: their contact makes a sound, but OUR ball sails straight
    // through it.
    const turn = turnDeg(vIn, vOut);
    const ratio = vOut.speed / Math.max(1e-6, vIn.speed);

    // How blind we were around the sound. Evidence 0.1 s away is a witness to
    // the strike; evidence 0.9 s away is a witness to the rally. `slack` is 1
    // inside tightSpanS and grows beyond it, and the thresholds grow with it,
    // so a far-away change has to be dramatic before it is credited to a
    // contact at T rather than to ordinary flight.
    const evidenceSpanS = first.t - last.t;
    const slack = Math.max(1, evidenceSpanS / params.tightSpanS);
    const needTurn = params.minTurnDeg * slack;
    const needRatio = 1 + (params.minSpeedRatio - 1) * slack;

    const changed = turn >= needTurn
      || ratio >= needRatio
      || ratio <= 1 / needRatio;
    if (!changed) { if (stats) stats.rejectedNoChange += 1; continue; }

    const prev = out[out.length - 1];
    if (prev && T - prev.t < params.minSpacingS) { if (stats) stats.rejectedSpacing += 1; continue; }

    // Confidence reflects the AGREEMENT, not the loudness. A loud onset that
    // barely bends the ball is weaker evidence than a quiet one that reverses
    // it, and onset strength on these clips tracks distance from the mic more
    // than it tracks anything about the shot.
    const turnTerm = Math.min(0.25, turn / 180);
    const paddleTerm = paddle && paddle.playerId === hitter.id ? 0.1 : 0;
    // ...and penalised for how far away the evidence was. A contact confirmed
    // across a 1.8 s blind span is a real contact far more often than not, but
    // it is not as certain as one confirmed three frames either side, and the
    // number a coach sees should say so.
    const slackPenalty = Math.min(0.3, (slack - 1) * 0.15);
    out.push({
      t: Math.round(T * 1000) / 1000,
      ball: ballAt,
      playerId: hitter.id,
      playerFeet: hitter.feet,
      overhead: null,
      confidence: Math.round(Math.max(0.3, Math.min(0.9, 0.5 + turnTerm + paddleTerm - slackPenalty)) * 100) / 100,
    });
    if (stats) stats.accepted += 1;
  }

  return out;
}


/**
 * On by default. Audio adds no cost beyond one ffmpeg pass and some DSP, and
 * every candidate it produces still has to satisfy the ball; the failure mode
 * of leaving it on is therefore "no change", not "wrong contacts".
 * AUDIO_CONTACTS=off disables it.
 */
export function audioContactsEnabled(): boolean {
  const v = (process.env.AUDIO_CONTACTS || "on").toLowerCase();
  return v !== "off" && v !== "0" && v !== "false";
}
