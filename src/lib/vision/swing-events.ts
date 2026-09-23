/**
 * WHEN a paddle contact probably happened, from the players' own arms.
 *
 * WHY THIS EXISTS. Contact timestamps used to come from the ball: ball.ts
 * tracked it, detectHits() found the direction changes, and everything that
 * measures technique hung off those moments. Ball tracking was removed -- it
 * was wrong often enough to poison what it fed, and it was the single most
 * expensive stage in the pipeline -- and nothing replaced the timestamps.
 *
 * So the machinery that measures body angles survived with nothing to measure
 * AT. facts.ts still groups rallies from `unknown_shot` events, still holds a
 * sorted array of the subject's pose frames, and still calls measureSwing()
 * for each contact; there were simply no contacts, so every per-shot mechanic
 * came back empty and the coaching model went back to judging technique by
 * eye. It even said so in a limitation nobody was going to read: "there is
 * simply no independent measurement to attach to them."
 *
 * A PADDLE SWING IS VISIBLE IN THE WRIST. The hand accelerates into the ball
 * and decelerates after it, which is a peak in wrist speed whether or not
 * anything knows where the ball is. That is a weaker signal than a tracked
 * ball -- it cannot tell a swing from a hard fake, and it does not know who
 * the ball was going to -- and it has two compensating virtues: it is free,
 * because the pose frames are already computed and stored, and it is measured
 * off the player rather than off a 40mm object that the detector loses against
 * a light background.
 *
 * WHAT IT IS HONEST ABOUT. Pose is sampled at VISION_FPS, which is 5, so the
 * samples are 200ms apart and a pickleball stroke lasts about 300. A peak is
 * therefore one or two samples wide and its timestamp is good to roughly
 * +/-100ms, not better. These are emitted as candidates with bounded
 * confidence, and the caller records a limitation saying what they are. The
 * rallies and shot types that a person actually reads still come from the
 * coaching pass watching the video; these exist so that the body angles
 * attached to them are measurements rather than impressions.
 *
 * THE THRESHOLD IS LEARNED PER PLAYER, not fixed. A fixed speed in body widths
 * per second has to be chosen for some combination of frame rate, camera
 * distance and how hard a particular person swings, and would be wrong for the
 * next clip. Each player's own median wrist speed and its median absolute
 * deviation set the bar instead: a contact is a moment when this player's arm
 * is moving much faster than this player usually moves it.
 */

import type { PlayerPoseFrame, PoseKeypoint, AnalysisEvent } from "./phase2-types";

/** Below this a keypoint is a guess, and a guess moving fast is not a swing. */
const MIN_KP_CONFIDENCE = 0.35;

/**
 * The longest gap across which two pose frames can be compared.
 *
 * Half a second. Past that the player has been out of view or undetected, the
 * wrist has moved somewhere unrelated, and the "speed" between the two samples
 * is an artefact of the gap rather than of any swing.
 */
const MAX_DT_S = 0.5;

/**
 * How far above a player's own baseline counts as a swing.
 *
 * Median plus four MADs. A MAD is about 0.67 sigma for normal noise, so this
 * is roughly two and a half standard deviations above typical -- deliberately
 * high, because the cost of a false contact is a fabricated technique note
 * about a swing that never happened, which is the exact failure the ball
 * tracker was removed for.
 */
const PEAK_MADS = 4;

/**
 * A floor under the learned threshold, in shoulder widths per second.
 *
 * Needed because MAD collapses on a player who barely moves: someone standing
 * at the baseline between points has a median near zero and a MAD near zero,
 * and median + 4 MADs would then flag ordinary fidgeting. A shoulder width is
 * around 40cm, so three of them a second is a hand crossing the body in a
 * third of a second -- slow for a drive, fast for standing about.
 */
const MIN_PEAK_SHOULDERS_PER_S = 3;

/**
 * The shortest believable time between two contacts by the SAME player.
 *
 * A player cannot hit twice in less than this; the ball has to reach an
 * opponent and come back. Even the fastest hands battle at the net is over
 * half a second per player, so anything closer is one swing sampled twice.
 */
const MIN_GAP_S = 0.5;

/**
 * How far away the NEAREST other contact may be before this one is dropped.
 *
 * A RALLY IS AN EXCHANGE, AND A LONE PEAK IS NOT ONE. Measured on ky-720p
 * (101s, 7 hand-labelled rallies, pose at 15fps, court-gated): of 28 contacts,
 * 10 landed in dead air -- somebody adjusting their hat between points, a
 * player jogging back, an arm thrown out mid-sprint. Requiring another contact
 * within two seconds cut the dead-air rate by 41% (0.17 to 0.10 per dead
 * second) while keeping 17 of the 18 real ones: a rally always has a second
 * contact near, and a man walking to the fence does not.
 *
 * This matters beyond the count. Every contact is a moment the coaching model
 * is handed BODY MEASUREMENTS for, so a contact between points measures the
 * posture of somebody standing still -- straight knees, upright chest -- and
 * hands it to the coach as the shape of a shot.
 */
const MAX_ISOLATION_S = 2.0;

/**
 * How many contacts a clip needs before isolation is allowed to judge any.
 *
 * The rule reads the SHAPE of a clip -- contacts come in exchanges -- and a
 * clip with four of them has no shape to read. Below this the filter would be
 * deciding on noise, and a run that found three contacts has bigger problems
 * than which of them is real.
 */
const MIN_FOR_ISOLATION = 6;

/**
 * How much taller the peak must be than the quiet either side of it.
 *
 * AND "EITHER SIDE" MEANS TWO OR THREE SAMPLES OUT, not the adjacent one.
 * Comparing against the immediate neighbours looked equivalent and threw away
 * the most ordinary case there is: a stroke lasts about 300ms and pose is
 * sampled every 200, so a swing routinely clears the bar on TWO consecutive
 * frames at nearly the same speed. Each of the two was then rejected for not
 * being taller than the other, and a real contact vanished -- silently, since
 * a detector that finds nothing looks exactly like a rally that had nothing in
 * it. Caught by a test that sampled one swing twice on purpose.
 *
 * The plateau is allowed to stand now, and the half-second refractory below
 * collapses it to a single contact, which is what it always was.
 */
const MIN_PROMINENCE = 1.25;

/** How far out the "quiet either side" is measured, in samples. */
const PROMINENCE_SKIP = 2;
const PROMINENCE_SPAN = 3;

export interface SwingEvent {
  playerId: string;
  timestampSeconds: number;
  /** Peak wrist speed, in the player's own shoulder widths per second. */
  peakShouldersPerSecond: number;
  /** How far above this player's own baseline, in MADs. */
  standardScore: number;
  confidence: number;
}

function kp(frame: PlayerPoseFrame, name: string): { x: number; y: number } | null {
  const k = frame.keypoints.find((p: PoseKeypoint) => p.name === name);
  if (!k || k.xNorm === null || k.yNorm === null) return null;
  if ((k.confidence ?? 0) < MIN_KP_CONFIDENCE) return null;
  return { x: k.xNorm, y: k.yNorm };
}

/**
 * The player's own ruler: the distance between their shoulders.
 *
 * Every speed below is divided by this, which is what makes a swing at the far
 * baseline comparable with one at the near baseline. Pixels are not: the same
 * stroke covers a third as many of them forty feet away.
 */
function shoulderWidth(frame: PlayerPoseFrame): number | null {
  const l = kp(frame, "left_shoulder");
  const r = kp(frame, "right_shoulder");
  if (!l || !r) return null;
  const w = Math.hypot(l.x - r.x, l.y - r.y);
  // A player square to the camera shows their full shoulder width; one turned
  // side-on shows almost none of it, and dividing by almost none turns an
  // ordinary movement into a spike. Below a fiftieth of the frame the ruler is
  // not measuring anything.
  return w > 0.02 ? w : null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Contact candidates for every player in the pose stream.
 *
 * Returns them sorted by time. An empty array is a perfectly ordinary answer:
 * a clip of people warming up has no contacts in it, and inventing some would
 * be worse than reporting none.
 */
export function detectSwingEvents(poses: PlayerPoseFrame[]): SwingEvent[] {
  const byPlayer = new Map<string, PlayerPoseFrame[]>();
  for (const f of poses) {
    const list = byPlayer.get(f.playerId);
    if (list) list.push(f);
    else byPlayer.set(f.playerId, [f]);
  }

  const out: SwingEvent[] = [];
  for (const [playerId, unsorted] of byPlayer) {
    const frames = [...unsorted].sort((a, b) => a.timestampSeconds - b.timestampSeconds);
    if (frames.length < 5) continue;

    // Wrist speed between consecutive frames, in shoulder widths per second,
    // timestamped at the LATER frame -- a swing is detected at the end of the
    // interval the hand accelerated through, which is where contact is.
    const series: Array<{ t: number; v: number }> = [];
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1];
      const b = frames[i];
      const dt = b.timestampSeconds - a.timestampSeconds;
      if (!(dt > 0) || dt > MAX_DT_S) continue;
      const sw = shoulderWidth(b) ?? shoulderWidth(a);
      if (sw === null) continue;
      let fastest: number | null = null;
      for (const side of ["left_wrist", "right_wrist"]) {
        const pa = kp(a, side);
        const pb = kp(b, side);
        if (!pa || !pb) continue;
        // THE FASTER WRIST, not the average of the two. Only one hand is on
        // the paddle, and averaging in the stationary hand halves every swing
        // -- which is exactly the kind of quiet signal loss that makes a
        // threshold look badly chosen when the measurement was the problem.
        const v = Math.hypot(pb.x - pa.x, pb.y - pa.y) / sw / dt;
        if (fastest === null || v > fastest) fastest = v;
      }
      if (fastest === null) continue;
      series.push({ t: b.timestampSeconds, v: fastest });
    }
    if (series.length < 5) continue;

    const vs = series.map((s) => s.v);
    const med = median(vs);
    const mad = median(vs.map((v) => Math.abs(v - med)));
    const threshold = Math.max(MIN_PEAK_SHOULDERS_PER_S, med + PEAK_MADS * mad);

    // Local maxima above the bar, prominent against their neighbours, then
    // thinned so no two survivors sit inside one exchange of the ball.
    const peaks: SwingEvent[] = [];
    for (let i = 1; i < series.length - 1; i++) {
      const { t, v } = series[i];
      if (v < threshold) continue;
      // A local maximum, allowed to tie: a two-frame plateau is one swing
      // sampled twice, not two swings and not a non-event.
      if (v < series[i - 1].v || v < series[i + 1].v) continue;
      // The quiet on each side, skipping the samples the swing itself occupies.
      let floor = Infinity;
      for (let d = PROMINENCE_SKIP; d <= PROMINENCE_SPAN; d++) {
        if (series[i - d]) floor = Math.min(floor, series[i - d].v);
        if (series[i + d]) floor = Math.min(floor, series[i + d].v);
      }
      if (!Number.isFinite(floor)) continue;
      if (v < floor * MIN_PROMINENCE) continue;
      const z = mad > 0 ? (v - med) / mad : PEAK_MADS;
      peaks.push({
        playerId,
        timestampSeconds: Math.round(t * 100) / 100,
        peakShouldersPerSecond: Math.round(v * 100) / 100,
        standardScore: Math.round(z * 10) / 10,
        // CAPPED AT 0.6, and the cap is the honest part. Pose sampled at 5fps
        // times a swing to about a fifth of a second, and a wrist peak cannot
        // tell a stroke from a hard fake or a practice swing between points.
        // A number above 0.6 here would be read downstream as near-certainty
        // about something this method cannot be near-certain of.
        confidence: Math.round(Math.min(0.6, 0.25 + (z - PEAK_MADS) * 0.05) * 100) / 100,
      });
    }

    // Strongest first, keeping each only if nothing already kept is within one
    // exchange. Greedy on strength rather than on time, so when a swing is
    // sampled twice the survivor is the frame nearer the actual contact.
    const kept: SwingEvent[] = [];
    for (const p of [...peaks].sort((a, b) => b.peakShouldersPerSecond - a.peakShouldersPerSecond)) {
      if (kept.some((k) => Math.abs(k.timestampSeconds - p.timestampSeconds) < MIN_GAP_S)) continue;
      kept.push(p);
    }
    out.push(...kept);
  }

  return dropIsolated(out.sort((a, b) => a.timestampSeconds - b.timestampSeconds));
}

/**
 * Drop contacts with nothing else near them in time. See MAX_ISOLATION_S.
 *
 * ACROSS PLAYERS, not within one: the second contact of an exchange is the
 * other team's, so requiring the same player to hit twice inside two seconds
 * would throw away every ordinary rally. A serve and its return are one
 * bounce apart, which is well inside the window.
 */
export function dropIsolated(
  swings: SwingEvent[],
  windowSeconds = MAX_ISOLATION_S
): SwingEvent[] {
  if (swings.length < MIN_FOR_ISOLATION) return swings;
  return swings.filter((s, i) => {
    const prev = swings[i - 1];
    const next = swings[i + 1];
    return (prev !== undefined && s.timestampSeconds - prev.timestampSeconds <= windowSeconds)
      || (next !== undefined && next.timestampSeconds - s.timestampSeconds <= windowSeconds);
  });
}

/** The AnalysisEvent shape the rest of the app already expects. */
export function swingsToUnknownShotEvents(swings: SwingEvent[]): AnalysisEvent[] {
  return swings.map((s) => ({
    type: "unknown_shot" as const,
    timestampSeconds: s.timestampSeconds,
    playerId: s.playerId,
    confidence: Math.max(0.1, Math.min(0.6, s.confidence)),
    source: "movement-heuristic" as const,
  }));
}
