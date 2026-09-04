/**
 * Ball tracking: turns per-frame ball detections (detect_ball.py, up to
 * top-k candidates per frame) into one continuous track, then reads the
 * physical events off that track — bounces (the ball touching the court)
 * and hits (a paddle changing its direction), the latter cross-checked
 * against the audio contacts that already exist upstream.
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
  /** Ball position at (nearest track point to) the hit; null if the ball was not seen within the window. */
  ball: { x: number; y: number } | null;
  /** Track label of the player most plausibly at the ball; null if nobody was close. */
  playerId: string | null;
  /** Feet position (bottom-center of the box) of that player at the hit, image-normalized. */
  playerFeet: { x: number; y: number } | null;
  /** Wrist-above-shoulder at the hit (from pose, when available) — an overhead cue. */
  overhead: boolean | null;
  /** 0-1: ball seen + direction change + player nearby all agree. */
  confidence: number;
  source: "audio+ball" | "audio-only" | "ball-only";
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
export function buildBallTrack(detections: BallDetection[], fps: number): { points: BallTrackPoint[]; stats: BallTrackStats } {
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

  const framesProcessed = frames.length;
  return {
    points,
    stats: {
      framesProcessed,
      pointsDetected: detected,
      pointsInterpolated: interpolated,
      coverage: framesProcessed > 0 ? Math.round((detected / framesProcessed) * 1000) / 1000 : 0,
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
// BOUNCE_CONTACT_EXCLUSION_S of an audio contact is a hit, not a bounce.
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

const HIT_WINDOW_S = 0.18; // how far a ball direction change may sit from the audio onset
const HIT_TURN_MIN_DEG = 25; // direction change that counts as a strike
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
 * Hits: for every audio contact, look for a sharp direction change of the
 * ball within ±HIT_WINDOW_S; take the ball position there and the nearest
 * player. A contact with no ball in view still yields a hit (audio is the
 * more reliable "when"), attributed by whichever player was nearest the
 * ball's last known position — at lower confidence.
 */
export function detectHits(
  points: BallTrackPoint[],
  contactsS: number[],
  playerTracks: PlayerTrack[],
  overheadAt?: (playerId: string, t: number) => boolean | null
): BallHit[] {
  const hits: BallHit[] = [];
  for (const tc of contactsS) {
    // candidate ball point: biggest direction change within the window, else nearest in time
    let bestIdx = -1;
    let bestTurn = 0;
    let nearestIdx = -1;
    let nearestDt = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dt = Math.abs(points[i].t - tc);
      if (dt < nearestDt) {
        nearestDt = dt;
        nearestIdx = i;
      }
      if (dt > HIT_WINDOW_S) continue;
      const turn = directionChangeDeg(points, i, 2);
      if (turn > bestTurn) {
        bestTurn = turn;
        bestIdx = i;
      }
    }
    const ballIdx = bestTurn >= HIT_TURN_MIN_DEG ? bestIdx : nearestDt <= HIT_WINDOW_S ? nearestIdx : -1;
    const ball = ballIdx >= 0 ? { x: points[ballIdx].x, y: points[ballIdx].y } : null;

    // nearest player to the ball (or, without a ball, nobody)
    let playerId: string | null = null;
    let playerFeet: { x: number; y: number } | null = null;
    let playerDist = Infinity;
    if (ball) {
      for (const tr of playerTracks) {
        const p = playerAt(tr, tc);
        if (!p) continue;
        const b = p.boxImageNorm;
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
    }

    const sawTurn = bestTurn >= HIT_TURN_MIN_DEG;
    const confidence = ball
      ? Math.min(0.95, 0.45 + (sawTurn ? 0.25 : 0) + (playerId ? 0.2 : 0) + Math.min(0.1, (points[ballIdx]?.conf ?? 0) * 0.1))
      : 0.3;
    hits.push({
      t: tc,
      ball,
      playerId,
      playerFeet,
      overhead: playerId && overheadAt ? overheadAt(playerId, tc) : null,
      confidence: Math.round(confidence * 100) / 100,
      source: ball ? "audio+ball" : "audio-only",
    });
  }
  return hits;
}
