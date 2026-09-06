/**
 * Ball tracking: turns per-frame ball detections (detect_ball.py, up to
 * top-k candidates per frame) into one continuous track, then reads the
 * physical events off that track — bounces (the ball touching the court)
 * and hits (a paddle changing direction sharply) — purely from the ball's
 * own trajectory. No audio signal is used anywhere in this app.
 *
 * That means a hit is only ever found where the ball was actually seen
 * turning sharply in the track above — there is no "we know a contact
 * happened, we just don't know where" fallback any more (that used to be
 * audio's job). A rally with poor ball coverage will genuinely show fewer
 * detected shots; that's disclosed via BallTrackStats.coverage and
 * QualityDiagnostics.knownLimitations, not papered over. Whether that's
 * good enough, or needs a second visual signal (e.g. player-swing timing
 * from pose) when the ball itself isn't visible, is open — see the
 * ball-detection-coverage work this is downstream of.
 *
 * Everything here is in normalized IMAGE space (x right, y DOWN, 0-1).
 * Court-plane positions are derived later, and only for points that are
 * actually on the court plane (bounces, players' feet) — a ball in the air
 * has no valid homography image, and this module never pretends it does.
 */

import type { PlayerTrack } from "./phase2-types";

export interface BallDetection {
  t: number;
  frame: number;
  /** Box center, normalized to frame size. */
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
}

export interface BallTrackPoint {
  t: number;
  x: number;
  y: number;
  conf: number;
  /** True when this point was filled in between two real detections. */
  interpolated: boolean;
}

export interface BallBounce {
  t: number;
  x: number;
  y: number;
  /** How pronounced the reversal was — larger is more certain. 0-1. */
  confidence: number;
}

export interface BallHit {
  t: number;
  /** Ball position at the detected direction-change — always present; a hit is only ever reported where the ball was seen. */
  ball: { x: number; y: number };
  /** Track label of the player most plausibly at the ball; null if nobody was close. */
  playerId: string | null;
  /** Feet position (bottom-center of the box) of that player at the hit, image-normalized. */
  playerFeet: { x: number; y: number } | null;
  /** Wrist-above-shoulder at the hit (from pose, when available) — an overhead cue. */
  overhead: boolean | null;
  /** 0-1: how sharp the turn was + whether a player was nearby. */
  confidence: number;
}

export interface BallTrackStats {
  framesProcessed: number;
  pointsDetected: number;
  pointsInterpolated: number;
  /** Fraction of processed frames with a real detection — the single best "can I trust the ball data" number. */
  coverage: number;
}

const GATE_BASE = 0.06; // how far (normalized) from the predicted position a candidate may be, at rest
const GATE_PER_SPEED = 1.4; // gate grows with speed (units: fraction of last step)
const MAX_GAP_FRAMES = 6; // longer gaps: stop predicting, re-acquire from scratch
const REACQUIRE_MIN_CONF = 0.35;

/**
 * Constant-velocity nearest-candidate association. Small and deterministic
 * on purpose: at 30 fps a pickleball's motion is close to linear between
 * frames, and the failure mode we care about most (locking onto a second
 * ball, a shoe, a line marker) is handled by gating on the prediction
 * rather than by trusting the highest-confidence box blindly.
 */
export function buildBallTrack(
  detections: BallDetection[],
  fps: number,
  /** Frames the detector actually looked at — coverage is detections over THIS, not over frames that happened to have a candidate. */
  framesProcessed?: number
): { points: BallTrackPoint[]; stats: BallTrackStats } {
  const byFrame = new Map<number, BallDetection[]>();
  for (const d of detections) {
    const list = byFrame.get(d.frame) ?? [];
    list.push(d);
    byFrame.set(d.frame, list);
  }
  const frames = [...byFrame.keys()].sort((a, b) => a - b);
  const points: BallTrackPoint[] = [];
  let last: BallTrackPoint | null = null;
  let prev: BallTrackPoint | null = null;
  let lastFrame = -1;
  let detected = 0;
  let interpolated = 0;

  for (const frame of frames) {
    const cands = byFrame.get(frame)!;
    const gapFrames = lastFrame >= 0 ? frame - lastFrame : Infinity;
    let chosen: BallDetection | null = null;

    if (last && gapFrames <= MAX_GAP_FRAMES) {
      const vx = prev ? (last.x - prev.x) / Math.max(1e-6, last.t - prev.t) : 0;
      const vy = prev ? (last.y - prev.y) / Math.max(1e-6, last.t - prev.t) : 0;
      const dt = gapFrames / fps;
      const px = last.x + vx * dt;
      const py = last.y + vy * dt;
      const stepLen = Math.hypot(vx * dt, vy * dt);
      const gate = GATE_BASE + GATE_PER_SPEED * stepLen + 0.01 * gapFrames;
      let best = Infinity;
      for (const c of cands) {
        const dist = Math.hypot(c.x - px, c.y - py);
        const score = dist / Math.max(0.2, c.conf); // prefer close, then confident
        if (dist <= gate && score < best) {
          best = score;
          chosen = c;
        }
      }
    }
    if (!chosen && (gapFrames > MAX_GAP_FRAMES || !last)) {
      // Re-acquire: only trust a clearly-detected ball to start a new segment.
      const top = [...cands].sort((a, b) => b.conf - a.conf)[0];
      if (top && top.conf >= REACQUIRE_MIN_CONF) chosen = top;
    }
    if (!chosen) continue;

    // Fill a short gap linearly so downstream velocity math sees a regular series.
    if (last && gapFrames > 1 && gapFrames <= MAX_GAP_FRAMES) {
      for (let g = 1; g < gapFrames; g++) {
        const f = g / gapFrames;
        points.push({
          t: last.t + (chosen.t - last.t) * f,
          x: last.x + (chosen.x - last.x) * f,
          y: last.y + (chosen.y - last.y) * f,
          conf: Math.min(last.conf, chosen.conf) * 0.5,
          interpolated: true,
        });
        interpolated += 1;
      }
    }
    const pt: BallTrackPoint = { t: chosen.t, x: chosen.x, y: chosen.y, conf: chosen.conf, interpolated: false };
    points.push(pt);
    detected += 1;
    prev = last;
    last = pt;
    lastFrame = frame;
  }

  const total = framesProcessed ?? frames.length;
  return {
    points,
    stats: {
      framesProcessed: total,
      pointsDetected: detected,
      pointsInterpolated: interpolated,
      coverage: total > 0 ? Math.round((detected / total) * 1000) / 1000 : 0,
    },
  };
}

/** Points strictly inside [startS, endS]. */
export function sliceTrack(points: BallTrackPoint[], startS: number, endS: number): BallTrackPoint[] {
  return points.filter((p) => p.t >= startS && p.t <= endS);
}

// Two bounce signatures, either is enough:
//  (a) a local maximum of image y with some prominence — the ball comes
//      down into the court and leaves upward. Clear for balls travelling
//      toward the camera.
//  (b) a kink in vertical velocity — vy drops sharply (was descending or
//      barely rising, now rising). This is the one that survives the far
//      court, where perspective shrinks a bounce to a few pixels and the
//      ball's travel away from the camera can hide the y-maximum entirely.
// A paddle strike produces both signatures too, so anything within
// BOUNCE_CONTACT_EXCLUSION_S of a detected hit (see detectHits) is a hit,
// not a bounce.
const BOUNCE_MIN_PROMINENCE = 0.006;
const BOUNCE_WINDOW = 5;
const KINK_WINDOW = 3; // frames each side for the velocity estimate
const KINK_MIN_DROP = 0.14; // normalized image heights per second
const BOUNCE_MIN_SPACING_S = 0.2;
const BOUNCE_CONTACT_EXCLUSION_S = 0.16;

export function detectBounces(points: BallTrackPoint[], contactsS: number[] = []): BallBounce[] {
  const out: BallBounce[] = [];
  const lo = Math.max(BOUNCE_WINDOW, KINK_WINDOW);
  for (let i = lo; i < points.length - lo; i++) {
    const p = points[i];
    if (p.interpolated) continue;
    if (contactsS.some((c) => Math.abs(c - p.t) <= BOUNCE_CONTACT_EXCLUSION_S)) continue;
    if (out.length && p.t - out[out.length - 1].t < BOUNCE_MIN_SPACING_S) continue;

    // (a) local maximum with prominence
    let isMax = true;
    for (let k = 1; k <= BOUNCE_WINDOW; k++) {
      if (points[i - k].y > p.y || points[i + k].y > p.y) {
        isMax = false;
        break;
      }
    }
    let prominence = 0;
    if (isMax) {
      let descend = 0, ascend = 0;
      for (let k = 1; k <= BOUNCE_WINDOW; k++) {
        descend = Math.max(descend, p.y - points[i - k].y);
        ascend = Math.max(ascend, p.y - points[i + k].y);
      }
      prominence = Math.min(descend, ascend);
    }

    // (b) vertical-velocity kink
    const b = points[i - KINK_WINDOW], a = points[i + KINK_WINDOW];
    const vyBefore = (p.y - b.y) / Math.max(1e-3, p.t - b.t);
    const vyAfter = (a.y - p.y) / Math.max(1e-3, a.t - p.t);
    const drop = vyBefore - vyAfter; // positive: started rising (relative to before)
    const kink = drop >= KINK_MIN_DROP && vyBefore > vyAfter;

    if (prominence >= BOUNCE_MIN_PROMINENCE || kink) {
      const confidence = Math.max(0.3, Math.min(0.95, Math.max(prominence * 25, (drop / KINK_MIN_DROP) * 0.35)));
      out.push({ t: p.t, x: p.x, y: p.y, confidence: Math.round(confidence * 100) / 100 });
    }
  }
  return out;
}

const HIT_TURN_WINDOW = 2; // frames each side used to measure the direction change at a point
const HIT_TURN_MIN_DEG = 25; // direction change that counts as a strike
const HIT_MIN_SPACING_S = 0.25; // two real strikes are never closer together than this
// A real strike reverses a ball that was already travelling with some
// pace; scanning the whole track for ANY sharp angle (rather than only
// checking near an already-known audio contact, like this used to) means
// ordinary tracking jitter on a slow or barely-moving ball reads as a
// "sharp turn" too -- small position noise produces a huge relative angle
// change when the ball barely moved. Requiring real speed on both legs
// of the turn is what audio's precise timing anchor used to do for free.
// Normalized image-units/second; unvalidated against hand-labeled shot
// times (none exist yet) -- tune against real footage the same way every
// other threshold in this file was.
const HIT_MIN_LEG_SPEED = 0.35;
const PLAYER_REACH = 0.16; // normalized image distance a player can plausibly reach from box center (scaled by box height)

function directionChangeDeg(points: BallTrackPoint[], i: number, span: number): number {
  const a = points[Math.max(0, i - span)];
  const b = points[i];
  const c = points[Math.min(points.length - 1, i + span)];
  const v1x = b.x - a.x, v1y = b.y - a.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const n1 = Math.hypot(v1x, v1y), n2 = Math.hypot(v2x, v2y);
  if (n1 < 1e-5 || n2 < 1e-5) return 0;
  const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (n1 * n2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

function legSpeed(a: BallTrackPoint, b: BallTrackPoint): number {
  const dt = Math.max(1e-3, Math.abs(b.t - a.t));
  return Math.hypot(b.x - a.x, b.y - a.y) / dt;
}

function playerAt(track: PlayerTrack, t: number) {
  // Player tracks are sampled at VISION_FPS; take the nearest point within 0.4s.
  let best: PlayerTrack["points"][number] | null = null;
  let bestDt = Infinity;
  for (const p of track.points) {
    const dt = Math.abs(p.timestampSeconds - t);
    if (dt < bestDt) {
      bestDt = dt;
      best = p;
    }
  }
  return best && bestDt <= 0.4 ? best : null;
}

/**
 * Hits: scan the ball track itself for a sharp direction change — a paddle
 * strike, or the ball bouncing off a wall/frame in a way that also turns
 * it sharply (bounces are filtered separately downstream by proximity to
 * the court plane; this function only reports "the ball's path bent
 * here"). No external "when" signal (audio) is used or needed — a real
 * strike is exactly the kind of event a tracked trajectory should show
 * directly. This also means: no ball seen turning sharply, no hit
 * reported, ever — there is no lower-confidence fallback for "we're
 * pretty sure a shot happened here but lost the ball". A rally where the
 * ball wasn't tracked well will simply come back with fewer shots; see
 * BallTrackStats.coverage for how much of the rally the ball was actually
 * visible for.
 */
export function detectHits(
  points: BallTrackPoint[],
  playerTracks: PlayerTrack[],
  overheadAt?: (playerId: string, t: number) => boolean | null
): BallHit[] {
  const hits: BallHit[] = [];
  for (let i = HIT_TURN_WINDOW; i < points.length - HIT_TURN_WINDOW; i++) {
    const p = points[i];
    if (p.interpolated) continue;
    if (hits.length && p.t - hits[hits.length - 1].t < HIT_MIN_SPACING_S) continue;
    const before = points[Math.max(0, i - HIT_TURN_WINDOW)];
    const after = points[Math.min(points.length - 1, i + HIT_TURN_WINDOW)];
    if (legSpeed(before, p) < HIT_MIN_LEG_SPEED || legSpeed(p, after) < HIT_MIN_LEG_SPEED) continue;
    const turn = directionChangeDeg(points, i, HIT_TURN_WINDOW);
    if (turn < HIT_TURN_MIN_DEG) continue;

    const ball = { x: p.x, y: p.y };

    // nearest player to the ball
    let playerId: string | null = null;
    let playerFeet: { x: number; y: number } | null = null;
    let playerDist = Infinity;
    for (const tr of playerTracks) {
      const pl = playerAt(tr, p.t);
      if (!pl) continue;
      const b = pl.boxImageNorm;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const reach = Math.max(PLAYER_REACH * 0.6, b.height * 0.9);
      const dist = Math.hypot((ball.x - cx) / Math.max(0.02, b.width * 1.6), (ball.y - cy) / Math.max(0.02, b.height * 0.9));
      if (dist < playerDist && Math.hypot(ball.x - cx, ball.y - cy) <= reach) {
        playerDist = dist;
        playerId = tr.playerId;
        playerFeet = { x: cx, y: b.y + b.height };
      }
    }

    const confidence = Math.min(
      0.95,
      0.5 + Math.min(0.25, (turn - HIT_TURN_MIN_DEG) / 100) + (playerId ? 0.2 : 0) + Math.min(0.1, p.conf * 0.1)
    );
    hits.push({
      t: p.t,
      ball,
      playerId,
      playerFeet,
      overhead: playerId && overheadAt ? overheadAt(playerId, p.t) : null,
      confidence: Math.round(confidence * 100) / 100,
    });
  }
  return hits;
}
