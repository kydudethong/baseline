/**
 * What the body actually did, in numbers, from the skeleton.
 *
 * WHY THIS EXISTS. Until now every technique field the product showed -- the
 * paddle, the shoulders, the contact point, the feet -- was a SENTENCE a model
 * wrote after watching a video. "Shoulders still square" is a reasonable thing
 * for a model to say and an unreasonable thing for a player to be told, because
 * neither of them can check it. The pose pass has been measuring seventeen
 * joints per player per frame this whole time and none of it reached the
 * coaching. The model was guessing at a thing sitting in the database.
 *
 * So: the angles are computed here, from the keypoints, and Gemini is handed
 * the measurements rather than asked to estimate them. It still does the part
 * it is good at -- deciding that 12 degrees of separation on a drive is late,
 * and saying so in a sentence a player can act on. It no longer does the part
 * it is bad at, which is reading a protractor off a video.
 *
 * TWO RULES RUN THROUGH ALL OF IT.
 *
 * Everything is in the BODY'S OWN UNITS. Shoulder width and torso length, not
 * pixels and not feet. A player at the far baseline is half the size of one at
 * the near kitchen line, and any measurement in pixels says they are playing
 * differently when they are not. Ratios and angles survive the camera; lengths
 * do not.
 *
 * A MISSING JOINT PRODUCES null, NEVER A NUMBER. YOLO regresses keypoints it
 * cannot see and marks them with low confidence; a knee angle computed from an
 * invented ankle is worse than no knee angle, because it will be reported with
 * the same authority as a real one and it is what the coaching will rest on.
 * Every function here returns null the moment an input it needs is absent.
 */

import type { CocoKeypointName, PlayerPoseFrame, PoseKeypoint } from "./phase2-types";

/**
 * The confidence below which a keypoint is treated as absent.
 *
 * 0.35, which is well under YOLO's own "confident" band and well over the
 * noise floor where it is regressing a joint it cannot see from the ones it
 * can. Occluded joints are the normal case in doubles -- a partner crosses in
 * front, a paddle hides a wrist -- so this threshold fires often and is
 * supposed to.
 */
export const MIN_KP_CONFIDENCE = 0.35;

/** A point in frame space, corrected for aspect so an angle means something. */
interface P { x: number; y: number }

export interface PreparationMeasures {
  /**
   * The shoulder line's angle away from square-to-the-net, in degrees.
   *
   * 0 means shoulders facing the net -- no turn at all. 90 means fully side-on.
   * This is the number behind "your preparation is late": a drive struck with
   * the shoulders still near 0 was hit with the arm alone.
   */
  shoulderTurnDeg: number | null;
  /**
   * Shoulder line minus hip line, in degrees: THE COIL.
   *
   * The most trustworthy measurement in this module, because it is one body
   * part against another and needs no reference to the court, the camera or
   * the net. Turning the shoulders while the hips stay is where the power in a
   * drive comes from; turning both together is a player swinging their whole
   * body at the ball.
   */
  hipShoulderSeparationDeg: number | null;
  /**
   * How long before contact the shoulders began to turn, in seconds.
   *
   * Null when the wind-up is not in the sampled frames. This is the literal
   * definition of "late preparation" and the reason the whole module exists --
   * everything else describes the position at contact, and this describes when
   * the player got there.
   */
  rotationLeadSeconds: number | null;
}

export interface ContactMeasures {
  /**
   * Paddle-hand height, with the hip at 0 and the shoulder at 1.
   *
   * Negative is below the hip -- a ball being lifted, which is a dink or a
   * player in trouble. Above 1 is overhead. Scaled to this player's own torso,
   * so it reads the same at both ends of the court.
   */
  contactHeightRatio: number | null;
  /**
   * How far in front of the lead ankle contact happened, in shoulder widths.
   *
   * Positive is in front, which is where a struck ball is met. Negative is the
   * number behind "you are hitting the ball behind you", and a player who has
   * been told that for years without ever seeing it measured tends to believe
   * it when they do.
   */
  contactAheadShoulderWidths: number | null;
  /** Which arm was extended at contact. Null when neither wrist is visible. */
  paddleSide: "left" | "right" | null;
  /**
   * Elbow angle of the paddle arm at contact, in degrees. 180 is straight.
   *
   * Reaching and blocking look identical in a still frame until you have this.
   */
  paddleElbowDeg: number | null;
}

export interface StanceMeasures {
  /** Knee angle of the more bent leg, in degrees. 180 is a straight leg. */
  kneeFlexionDeg: number | null;
  /** Ankle separation in shoulder widths. About 1.5 is an athletic base. */
  stanceWidthRatio: number | null;
  /**
   * Hip movement toward the net through contact, in torso lengths per second.
   *
   * Positive is moving in, negative is backing off the shot -- the thing that
   * turns a third-shot drop into a pop-up.
   *
   * ASSUMES A CAMERA BEHIND A BASELINE, where the net is up the frame. That is
   * how essentially every phone on a fence is placed, and this returns null
   * rather than a wrong sign when the court data says otherwise.
   */
  driftTowardNetTorsosPerSecond: number | null;
}

export interface ReadyMeasures {
  /** Paddle-hand height between shots, on the same hip=0/shoulder=1 scale. */
  readyPaddleHeightRatio: number | null;
  /** Knee angle while waiting. A player standing straight is not ready. */
  readyKneeFlexionDeg: number | null;
  /**
   * Seconds from contact until the player is back in their own ready position.
   *
   * Measured against that player's OWN median rather than an ideal, because
   * the question is whether they reset, not whether their reset matches a
   * textbook. Null when they never got back before the next shot.
   */
  resetSeconds: number | null;
}

export interface BodyMeasures extends
  PreparationMeasures, ContactMeasures, StanceMeasures, ReadyMeasures {
  /** The moment these describe. */
  tSeconds: number;
  playerId: string;
  /**
   * How much of the above is real, 0..1: the share of the measurements that
   * came out non-null.
   *
   * Carried so the coaching prompt can be told to lean on a shot measured at
   * 0.9 and to say nothing about one at 0.2, rather than treating a skeleton
   * glimpsed through a partner as equal evidence.
   */
  completeness: number;
}

// --------------------------------------------------------------------------
// keypoint access
// --------------------------------------------------------------------------

/**
 * A keypoint as a usable point, or null.
 *
 * `aspect` is width/height of the frame. Without it every angle in this file
 * would be wrong by the frame's aspect ratio -- normalized coordinates squash
 * a 16:9 frame into a square, and a shoulder line at a true 30 degrees reads
 * as 50. It is a one-line correction and the difference between a measurement
 * and a number that looks like one.
 */
function pt(frame: PlayerPoseFrame, name: CocoKeypointName, aspect: number): P | null {
  const kp: PoseKeypoint | undefined = frame.keypoints.find((k) => k.name === name);
  if (!kp || kp.xNorm === null || kp.yNorm === null) return null;
  if ((kp.confidence ?? 0) < MIN_KP_CONFIDENCE) return null;
  if (!Number.isFinite(kp.xNorm) || !Number.isFinite(kp.yNorm)) return null;
  return { x: kp.xNorm * aspect, y: kp.yNorm };
}

function mid(a: P | null, b: P | null): P | null {
  if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function dist(a: P, b: P): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * The angle of a line, folded into 0..90 degrees from horizontal.
 *
 * Folded rather than signed because a player turning left and a player turning
 * right are doing the same thing, and the sign here only says which handed
 * side of the court they are on.
 */
function lineTiltDeg(a: P, b: P): number {
  const deg = Math.abs(Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI);
  const folded = deg > 90 ? 180 - deg : deg;
  return folded;
}

/** Interior angle at `b`, in degrees. The joint-angle workhorse. */
function jointAngleDeg(a: P, b: P, c: P): number | null {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const m1 = Math.hypot(v1.x, v1.y), m2 = Math.hypot(v2.x, v2.y);
  // A zero-length limb means two joints landed on the same pixel, which is a
  // detection failure rather than a body folded flat.
  if (m1 < 1e-6 || m2 < 1e-6) return null;
  const cos = Math.min(1, Math.max(-1, (v1.x * v2.x + v1.y * v2.y) / (m1 * m2)));
  return Math.acos(cos) * 180 / Math.PI;
}

/** Shoulder width, the unit everything lateral is measured in. */
function shoulderWidth(f: PlayerPoseFrame, aspect: number): number | null {
  const l = pt(f, "left_shoulder", aspect), r = pt(f, "right_shoulder", aspect);
  if (!l || !r) return null;
  const w = dist(l, r);
  return w > 1e-4 ? w : null;
}

/** Shoulder-midpoint to hip-midpoint: the unit everything vertical uses. */
function torsoLength(f: PlayerPoseFrame, aspect: number): number | null {
  const sh = mid(pt(f, "left_shoulder", aspect), pt(f, "right_shoulder", aspect));
  const hp = mid(pt(f, "left_hip", aspect), pt(f, "right_hip", aspect));
  if (!sh || !hp) return null;
  const d = dist(sh, hp);
  return d > 1e-4 ? d : null;
}

// --------------------------------------------------------------------------
// the measurements
// --------------------------------------------------------------------------

/**
 * How square the shoulders are to the net, and how far the hips lag them.
 *
 * `netTiltDeg` is the net's own angle in the frame when court detection found
 * it, so a camera mounted at a corner does not read as every player standing
 * open. It defaults to 0 -- a level net across the frame -- which is what a
 * phone on a fence behind the baseline gives.
 */
export function preparationAt(
  frames: PlayerPoseFrame[],
  tSeconds: number,
  aspect: number,
  netTiltDeg = 0
): PreparationMeasures {
  const f = frameAt(frames, tSeconds);
  if (!f) return { shoulderTurnDeg: null, hipShoulderSeparationDeg: null, rotationLeadSeconds: null };

  const ls = pt(f, "left_shoulder", aspect), rs = pt(f, "right_shoulder", aspect);
  const lh = pt(f, "left_hip", aspect), rh = pt(f, "right_hip", aspect);

  const shoulderLine = ls && rs ? lineTiltDeg(ls, rs) : null;
  const hipLine = lh && rh ? lineTiltDeg(lh, rh) : null;

  // Square to the net is the shoulder line PARALLEL to the net, so the turn is
  // how far it has departed from the net's own tilt.
  const shoulderTurnDeg = shoulderLine === null
    ? null
    : foldTo90(Math.abs(shoulderLine - netTiltDeg));

  const hipShoulderSeparationDeg = shoulderLine === null || hipLine === null
    ? null
    : foldTo90(Math.abs(shoulderLine - hipLine));

  return {
    shoulderTurnDeg,
    hipShoulderSeparationDeg,
    rotationLeadSeconds: rotationLead(frames, tSeconds, aspect),
  };
}

function foldTo90(deg: number): number {
  const d = Math.abs(deg) % 180;
  return d > 90 ? 180 - d : d;
}

/**
 * How long before contact the shoulders started turning.
 *
 * Walks BACKWARDS from contact while the shoulder line keeps changing, and
 * stops at the first frame where it has gone quiet. The answer is the gap
 * between that frame and contact.
 *
 * QUIET IS 4 DEGREES PER SAMPLE, not zero. Keypoints jitter by a degree or two
 * on a stationary player, so a zero threshold would walk back to the start of
 * the clip and report every preparation as enormously early.
 */
const ROTATION_QUIET_DEG = 4;
/** No preparation takes longer than this; past it we are tracking the last rally. */
const ROTATION_MAX_LOOKBACK_S = 1.5;

function rotationLead(frames: PlayerPoseFrame[], tSeconds: number, aspect: number): number | null {
  const ordered = frames
    .filter((f) => f.timestampSeconds <= tSeconds + 1e-6
                && f.timestampSeconds >= tSeconds - ROTATION_MAX_LOOKBACK_S)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);
  if (ordered.length < 3) return null;

  const angles: Array<{ t: number; deg: number }> = [];
  for (const f of ordered) {
    const ls = pt(f, "left_shoulder", aspect), rs = pt(f, "right_shoulder", aspect);
    if (ls && rs) angles.push({ t: f.timestampSeconds, deg: lineTiltDeg(ls, rs) });
  }
  if (angles.length < 3) return null;

  const contactT = angles[angles.length - 1].t;
  let startT: number | null = null;
  for (let i = angles.length - 1; i > 0; i--) {
    const delta = Math.abs(foldTo90(angles[i].deg - angles[i - 1].deg));
    if (delta < ROTATION_QUIET_DEG) break;
    startT = angles[i - 1].t;
  }
  if (startT === null) return null;
  const lead = contactT - startT;
  return lead > 0 ? Number(lead.toFixed(3)) : null;
}

/** Where the paddle hand met the ball, relative to this player's own body. */
export function contactAt(
  frames: PlayerPoseFrame[],
  tSeconds: number,
  aspect: number
): ContactMeasures {
  const none: ContactMeasures = {
    contactHeightRatio: null, contactAheadShoulderWidths: null,
    paddleSide: null, paddleElbowDeg: null,
  };
  const f = frameAt(frames, tSeconds);
  if (!f) return none;

  const shMid = mid(pt(f, "left_shoulder", aspect), pt(f, "right_shoulder", aspect));
  const hpMid = mid(pt(f, "left_hip", aspect), pt(f, "right_hip", aspect));
  const lw = pt(f, "left_wrist", aspect), rw = pt(f, "right_wrist", aspect);

  // THE PADDLE HAND IS THE ONE FURTHEST FROM THE BODY'S CENTRE LINE. Handedness
  // is not recorded anywhere and a player's dominant side can be inferred wrong
  // from a single frame, but the arm holding the paddle at the moment of a
  // stroke is the extended one, every time.
  let paddle: P | null = null;
  let paddleSide: "left" | "right" | null = null;
  if (shMid && (lw || rw)) {
    const dl = lw ? Math.abs(lw.x - shMid.x) : -1;
    const dr = rw ? Math.abs(rw.x - shMid.x) : -1;
    if (dl >= dr && lw) { paddle = lw; paddleSide = "left"; }
    else if (rw) { paddle = rw; paddleSide = "right"; }
  }

  // y grows downward, so a hand ABOVE the hip has the smaller y. The ratio is
  // built to read the way a coach talks: hip 0, shoulder 1, overhead above 1.
  const contactHeightRatio = paddle && shMid && hpMid && Math.abs(hpMid.y - shMid.y) > 1e-6
    ? round2((hpMid.y - paddle.y) / (hpMid.y - shMid.y))
    : null;

  const sw = shoulderWidth(f, aspect);
  const la = pt(f, "left_ankle", aspect), ra = pt(f, "right_ankle", aspect);
  // The LEAD foot is the one nearer the net, and the net is up the frame: the
  // smaller y. With one ankle visible that ankle is the best available answer.
  const lead = la && ra ? (la.y < ra.y ? la : ra) : (la ?? ra);
  const contactAheadShoulderWidths = paddle && lead && sw
    // "In front" is toward the net, which is up the frame. A hand higher up the
    // image than the lead foot is out in front of it from the camera's view.
    ? round2((lead.y - paddle.y) / sw)
    : null;

  let paddleElbowDeg: number | null = null;
  if (paddleSide) {
    const sName = paddleSide === "left" ? "left_shoulder" : "right_shoulder";
    const eName = paddleSide === "left" ? "left_elbow" : "right_elbow";
    const wName = paddleSide === "left" ? "left_wrist" : "right_wrist";
    const s = pt(f, sName, aspect), e = pt(f, eName, aspect), w = pt(f, wName, aspect);
    if (s && e && w) {
      const a = jointAngleDeg(s, e, w);
      paddleElbowDeg = a === null ? null : round1(a);
    }
  }

  return { contactHeightRatio, contactAheadShoulderWidths, paddleSide, paddleElbowDeg };
}

/** The base the shot was hit from, and whether it was moving the right way. */
export function stanceAt(
  frames: PlayerPoseFrame[],
  tSeconds: number,
  aspect: number
): StanceMeasures {
  const none: StanceMeasures = {
    kneeFlexionDeg: null, stanceWidthRatio: null, driftTowardNetTorsosPerSecond: null,
  };
  const f = frameAt(frames, tSeconds);
  if (!f) return none;

  const knees: number[] = [];
  for (const side of ["left", "right"] as const) {
    const h = pt(f, `${side}_hip` as CocoKeypointName, aspect);
    const k = pt(f, `${side}_knee` as CocoKeypointName, aspect);
    const a = pt(f, `${side}_ankle` as CocoKeypointName, aspect);
    if (h && k && a) {
      const deg = jointAngleDeg(h, k, a);
      if (deg !== null) knees.push(deg);
    }
  }
  // The MORE BENT leg, which is the smaller angle: in a split step or a lunge
  // the legs do different jobs and averaging them describes neither.
  const kneeFlexionDeg = knees.length ? round1(Math.min(...knees)) : null;

  const la = pt(f, "left_ankle", aspect), ra = pt(f, "right_ankle", aspect);
  const sw = shoulderWidth(f, aspect);
  const stanceWidthRatio = la && ra && sw ? round2(dist(la, ra) / sw) : null;

  return { kneeFlexionDeg, stanceWidthRatio, driftTowardNetTorsosPerSecond: drift(frames, tSeconds, aspect) };
}

/** How far either side of contact the drift is measured over. */
const DRIFT_WINDOW_S = 0.3;

function drift(frames: PlayerPoseFrame[], tSeconds: number, aspect: number): number | null {
  const before = frameAt(frames, tSeconds - DRIFT_WINDOW_S, DRIFT_WINDOW_S / 2);
  const after = frameAt(frames, tSeconds + DRIFT_WINDOW_S, DRIFT_WINDOW_S / 2);
  if (!before || !after) return null;
  const h0 = mid(pt(before, "left_hip", aspect), pt(before, "right_hip", aspect));
  const h1 = mid(pt(after, "left_hip", aspect), pt(after, "right_hip", aspect));
  const torso = torsoLength(after, aspect) ?? torsoLength(before, aspect);
  if (!h0 || !h1 || !torso) return null;
  const dt = after.timestampSeconds - before.timestampSeconds;
  if (dt <= 1e-3) return null;
  // Up the frame is toward the net, so a shrinking y is forward. The sign is
  // flipped here once, where it can be reasoned about, rather than at the call
  // sites where it would be flipped inconsistently.
  return round2(((h0.y - h1.y) / torso) / dt);
}

/**
 * How many frames it takes before a median describes a ready position rather
 * than an accident. Five, which at 10fps is half a second of the player simply
 * existing on court -- less than that and the "baseline" is one moment.
 */
export const MIN_READY_SAMPLES = 5;

/**
 * What the player looked like between shots, and how fast they got back there.
 *
 * `nextContactT` bounds the search: a reset that happens after the next ball
 * has been struck is not a reset, it is the next shot.
 */
export function readyAfter(
  frames: PlayerPoseFrame[],
  tSeconds: number,
  aspect: number,
  nextContactT: number | null
): ReadyMeasures {
  const none: ReadyMeasures = {
    readyPaddleHeightRatio: null, readyKneeFlexionDeg: null, resetSeconds: null,
  };
  const limit = nextContactT ?? tSeconds + 3;
  const after = frames
    .filter((f) => f.timestampSeconds > tSeconds && f.timestampSeconds <= limit)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);
  if (after.length === 0) return none;

  // The player's own baseline, from the whole clip rather than this rally: the
  // question is whether they returned to THEIR ready position, and a median
  // over everything is the only honest description of what that is.
  //
  // WITH A FLOOR ON HOW MANY SAMPLES MAKE A BASELINE. A median of two frames
  // taken mid-swing says the player's resting paddle height is shoulder-high,
  // and the reset time computed against it comes out near zero -- the code
  // reporting a perfect reset precisely when it has no idea. Below the floor
  // there is no ready position to have returned to, and the answer is null.
  const baseHeights: number[] = [];
  const baseKnees: number[] = [];
  for (const f of frames) {
    const c = contactAt([f], f.timestampSeconds, aspect);
    const s = stanceAt([f], f.timestampSeconds, aspect);
    if (c.contactHeightRatio !== null) baseHeights.push(c.contactHeightRatio);
    if (s.kneeFlexionDeg !== null) baseKnees.push(s.kneeFlexionDeg);
  }
  const readyPaddleHeightRatio = baseHeights.length >= MIN_READY_SAMPLES
    ? round2(median(baseHeights)) : null;
  const readyKneeFlexionDeg = baseKnees.length >= MIN_READY_SAMPLES
    ? round1(median(baseKnees)) : null;

  let resetSeconds: number | null = null;
  if (readyPaddleHeightRatio !== null) {
    for (const f of after) {
      const c = contactAt([f], f.timestampSeconds, aspect);
      if (c.contactHeightRatio === null) continue;
      // Within a fifth of the hip-to-shoulder span counts as back: asking for
      // an exact match would report that nobody ever resets.
      if (Math.abs(c.contactHeightRatio - readyPaddleHeightRatio) <= 0.2) {
        resetSeconds = round2(f.timestampSeconds - tSeconds);
        break;
      }
    }
  }

  return { readyPaddleHeightRatio, readyKneeFlexionDeg, resetSeconds };
}

/** Everything, for one shot. The function the pipeline calls. */
export function measureShot(opts: {
  frames: PlayerPoseFrame[];
  playerId: string;
  tSeconds: number;
  /** Frame width / height. Angles are wrong without it. */
  aspect: number;
  netTiltDeg?: number;
  nextContactT?: number | null;
}): BodyMeasures {
  const { frames, playerId, tSeconds, aspect } = opts;
  const mine = frames.filter((f) => f.playerId === playerId);
  const prep = preparationAt(mine, tSeconds, aspect, opts.netTiltDeg ?? 0);
  const contact = contactAt(mine, tSeconds, aspect);
  const stance = stanceAt(mine, tSeconds, aspect);
  const ready = readyAfter(mine, tSeconds, aspect, opts.nextContactT ?? null);

  const all = { ...prep, ...contact, ...stance, ...ready };
  const values = Object.entries(all)
    .filter(([k]) => k !== "paddleSide")
    .map(([, v]) => v);
  const present = values.filter((v) => v !== null).length;

  return {
    ...all,
    tSeconds,
    playerId,
    completeness: values.length ? round2(present / values.length) : 0,
  };
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

/** The pose frame nearest a time, within a tolerance. */
function frameAt(
  frames: PlayerPoseFrame[],
  tSeconds: number,
  toleranceS = 0.15
): PlayerPoseFrame | null {
  let best: PlayerPoseFrame | null = null;
  let bestDt = toleranceS;
  for (const f of frames) {
    const dt = Math.abs(f.timestampSeconds - tSeconds);
    if (dt <= bestDt) { bestDt = dt; best = f; }
  }
  return best;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function round1(x: number): number { return Math.round(x * 10) / 10; }
function round2(x: number): number { return Math.round(x * 100) / 100; }
