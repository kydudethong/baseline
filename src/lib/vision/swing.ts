/**
 * Swing mechanics from body pose, measured around a single contact.
 *
 * The point of this module is to answer technique questions the shot list
 * cannot: not "you hit a dink" but "you hit it with straight legs, from below
 * your knees, with almost no follow-through". That needs the body at the
 * MOMENT of contact and either side of it, which is why the pipeline samples
 * pose in bursts around contacts rather than relying on the 5 fps pass — a
 * swing lasts about a third of a second, so at 5 fps it is one or two frames
 * and there is no swing in the data to measure.
 *
 * Everything here is measured in SHOULDER WIDTHS and degrees, never pixels.
 * A player at the far baseline is half the size on screen of one at the near
 * baseline; any threshold in image units would therefore mean two different
 * things at the two ends of the court, which is exactly the bug that made the
 * hit detector deaf to the far half. Normalising by the player's own body
 * removes the camera from the measurement entirely.
 *
 * Nothing here sees a paddle. Wrist position is the closest observable, and
 * every field is named for what was actually measured so the coaching layer
 * cannot quietly promote a wrist into a paddle.
 */
import type { CocoKeypointName, PlayerPoseFrame, PoseKeypoint } from "./phase2-types";

export interface SwingMetrics {
  /** Pose frames found inside the window — under ~6 and the rest is guesswork. */
  samples: number;
  hand: "left" | "right" | "unknown";
  /** Knee angle at contact: 180 = straight leg, 90 = deep squat. */
  kneeAngleAtContactDeg: number | null;
  /** Deepest knee bend anywhere in the window. */
  kneeAngleMinDeg: number | null;
  /**
   * Wrist height at contact relative to the torso: 0 = shoulder line,
   * 1 = a full torso length ABOVE the shoulders, -1 = down at hip level.
   */
  contactHeightTorsos: number | null;
  /** Wrist distance from the shoulder line at contact, in shoulder widths. */
  contactReachShoulders: number | null;
  /** Furthest the hitting wrist got from the body in the wind-up. */
  backswingShoulders: number | null;
  /** Hitting-wrist speed over the moments before contact, shoulder widths/s. */
  wristSpeedIntoContact: number | null;
  /** Furthest the wrist travelled from the body after contact. */
  followThroughShoulders: number | null;
  /** How far the shoulder line turned between wind-up and contact. */
  shoulderRotationDeg: number | null;
  /** 0-1. Degrades with missing keypoints and thin sampling — never invented. */
  confidence: number;
  /** Named reasons a field is null, so a gap is diagnosable rather than mute. */
  missing: string[];
}

const MIN_KP_CONF = 0.3;
/** How far either side of the contact counts as part of the swing. */
export const SWING_WINDOW_S = 0.5;
const WINDUP_S = 0.3;
const SPEED_WINDOW_S = 0.15;

type XY = { x: number; y: number };

function kp(frame: PlayerPoseFrame, name: CocoKeypointName): XY | null {
  const k: PoseKeypoint | undefined = frame.keypoints.find((q) => q.name === name);
  if (!k || k.xNorm === null || k.yNorm === null) return null;
  if ((k.confidence ?? 0) < MIN_KP_CONF) return null;
  return { x: k.xNorm, y: k.yNorm };
}

function mid(a: XY | null, b: XY | null): XY | null {
  if (a && b) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return a ?? b ?? null;
}

function dist(a: XY, b: XY): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angleDeg(a: XY, b: XY, c: XY): number {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const n1 = Math.hypot(v1.x, v1.y), n2 = Math.hypot(v2.x, v2.y);
  if (n1 < 1e-6 || n2 < 1e-6) return NaN;
  const cos = Math.min(1, Math.max(-1, (v1.x * v2.x + v1.y * v2.y) / (n1 * n2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Straightest-leg reading of the two, so a planted leg is not hidden by a trailing one. */
function kneeAngle(f: PlayerPoseFrame): number | null {
  const legs: number[] = [];
  for (const side of ["left", "right"] as const) {
    const hip = kp(f, `${side}_hip` as CocoKeypointName);
    const knee = kp(f, `${side}_knee` as CocoKeypointName);
    const ankle = kp(f, `${side}_ankle` as CocoKeypointName);
    if (!hip || !knee || !ankle) continue;
    const a = angleDeg(hip, knee, ankle);
    if (Number.isFinite(a)) legs.push(a);
  }
  return legs.length ? Math.min(...legs) : null;
}

function shoulderWidth(f: PlayerPoseFrame): number | null {
  const l = kp(f, "left_shoulder"), r = kp(f, "right_shoulder");
  if (!l || !r) return null;
  const w = dist(l, r);
  return w > 1e-4 ? w : null;
}

/**
 * Which hand is swinging: the wrist that travels furthest from the shoulder
 * line across the window. Paddle sports are one-handed, so the hitting arm is
 * the one that actually goes somewhere.
 */
function hittingHand(frames: PlayerPoseFrame[]): "left" | "right" | "unknown" {
  let best: { hand: "left" | "right"; reach: number } | null = null;
  for (const hand of ["left", "right"] as const) {
    let reach = 0, seen = 0;
    for (const f of frames) {
      const w = kp(f, `${hand}_wrist` as CocoKeypointName);
      const sc = mid(kp(f, "left_shoulder"), kp(f, "right_shoulder"));
      const sw = shoulderWidth(f);
      if (!w || !sc || !sw) continue;
      seen += 1;
      reach = Math.max(reach, dist(w, sc) / sw);
    }
    if (seen >= 2 && (!best || reach > best.reach)) best = { hand, reach };
  }
  return best ? best.hand : "unknown";
}

/**
 * Measure one swing.
 *
 * `frames` is every pose for ONE player; only those inside the window around
 * `contactS` are used, so the caller can pass a whole rally's worth.
 */
export function measureSwing(
  frames: PlayerPoseFrame[],
  contactS: number,
  windowS: number = SWING_WINDOW_S
): SwingMetrics {
  const missing: string[] = [];
  const win = frames
    .filter((f) => Math.abs(f.timestampSeconds - contactS) <= windowS)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const empty: SwingMetrics = {
    samples: win.length, hand: "unknown",
    kneeAngleAtContactDeg: null, kneeAngleMinDeg: null,
    contactHeightTorsos: null, contactReachShoulders: null,
    backswingShoulders: null, wristSpeedIntoContact: null,
    followThroughShoulders: null, shoulderRotationDeg: null,
    confidence: 0, missing,
  };
  if (win.length === 0) { missing.push("no pose frames in the swing window"); return empty; }

  // The frame nearest the contact IS the contact frame; with burst sampling it
  // is within a frame or two, and how close is reported through confidence.
  let atContact = win[0];
  for (const f of win) {
    if (Math.abs(f.timestampSeconds - contactS) < Math.abs(atContact.timestampSeconds - contactS)) atContact = f;
  }
  const contactOffset = Math.abs(atContact.timestampSeconds - contactS);

  const hand = hittingHand(win);
  if (hand === "unknown") missing.push("could not tell which arm was swinging");

  const sw = shoulderWidth(atContact)
    ?? (win.map(shoulderWidth).filter((v): v is number => v !== null).sort((a, b) => a - b)[Math.floor(win.length / 2)] ?? null);
  if (sw === null) missing.push("shoulders not visible, so nothing could be scaled to the body");

  const out: SwingMetrics = { ...empty, hand };

  out.kneeAngleAtContactDeg = kneeAngle(atContact);
  if (out.kneeAngleAtContactDeg === null) missing.push("legs not visible at contact");
  const knees = win.map(kneeAngle).filter((v): v is number => v !== null);
  out.kneeAngleMinDeg = knees.length ? Math.min(...knees) : null;

  const wristName = hand === "unknown" ? null : (`${hand}_wrist` as CocoKeypointName);
  const wristAt = (f: PlayerPoseFrame) => (wristName ? kp(f, wristName) : null);

  if (sw !== null && wristName) {
    const shouldersAt = (f: PlayerPoseFrame) => mid(kp(f, "left_shoulder"), kp(f, "right_shoulder"));
    const hipsAt = (f: PlayerPoseFrame) => mid(kp(f, "left_hip"), kp(f, "right_hip"));

    const w0 = wristAt(atContact), s0 = shouldersAt(atContact), h0 = hipsAt(atContact);
    if (w0 && s0) out.contactReachShoulders = round2(dist(w0, s0) / sw);
    if (w0 && s0 && h0) {
      const torso = dist(s0, h0);
      // Image y grows downward, so a wrist ABOVE the shoulders has the smaller y.
      if (torso > 1e-4) out.contactHeightTorsos = round2((s0.y - w0.y) / torso);
    }
    if (!w0) missing.push("hitting wrist not visible at contact");

    let back = 0, backSeen = false;
    let follow = 0, followSeen = false;
    for (const f of win) {
      const w = wristAt(f), s = shouldersAt(f);
      if (!w || !s) continue;
      const r = dist(w, s) / sw;
      if (f.timestampSeconds < atContact.timestampSeconds) { back = Math.max(back, r); backSeen = true; }
      if (f.timestampSeconds > atContact.timestampSeconds) { follow = Math.max(follow, r); followSeen = true; }
    }
    out.backswingShoulders = backSeen ? round2(back) : null;
    out.followThroughShoulders = followSeen ? round2(follow) : null;
    if (!backSeen) missing.push("no frames before contact");
    if (!followSeen) missing.push("no frames after contact");

    // Speed over the approach to contact, not across the whole window: a swing
    // accelerates, so averaging in the wind-up understates it badly.
    const approach = win.filter((f) =>
      f.timestampSeconds <= atContact.timestampSeconds &&
      atContact.timestampSeconds - f.timestampSeconds <= SPEED_WINDOW_S);
    if (approach.length >= 2) {
      const a = approach[0], b = approach[approach.length - 1];
      const wa = wristAt(a), wb = wristAt(b);
      const dt = b.timestampSeconds - a.timestampSeconds;
      if (wa && wb && dt > 1e-3) out.wristSpeedIntoContact = round2(dist(wa, wb) / sw / dt);
    }
    if (out.wristSpeedIntoContact === null) missing.push("too few frames just before contact to measure swing speed");

    // Shoulder line turn between wind-up and contact.
    const windup = win.filter((f) => atContact.timestampSeconds - f.timestampSeconds >= WINDUP_S * 0.6);
    const lineAngle = (f: PlayerPoseFrame): number | null => {
      const l = kp(f, "left_shoulder"), r = kp(f, "right_shoulder");
      if (!l || !r) return null;
      return (Math.atan2(r.y - l.y, r.x - l.x) * 180) / Math.PI;
    };
    const a0 = windup.length ? lineAngle(windup[windup.length - 1]) : null;
    const a1 = lineAngle(atContact);
    if (a0 !== null && a1 !== null) {
      let d = Math.abs(a1 - a0) % 360;
      if (d > 180) d = 360 - d;
      out.shoulderRotationDeg = Math.round(d);
    } else missing.push("shoulder rotation needs a clear view of both shoulders before and at contact");
  }

  // Confidence is a report on the measurement, not on the player. Thin
  // sampling, a contact frame that is not really at the contact, and missing
  // fields each pull it down; nothing pushes it up.
  const filled = [out.kneeAngleAtContactDeg, out.contactHeightTorsos, out.contactReachShoulders,
                  out.backswingShoulders, out.wristSpeedIntoContact, out.followThroughShoulders,
                  out.shoulderRotationDeg].filter((v) => v !== null).length;
  const sampleTerm = Math.min(1, win.length / 8);
  const offsetTerm = Math.max(0, 1 - contactOffset / 0.12);
  out.confidence = Math.round(Math.min(0.95, (filled / 7) * 0.6 + sampleTerm * 0.25 + offsetTerm * 0.15) * 100) / 100;
  out.samples = win.length;
  out.missing = missing;
  return out;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
