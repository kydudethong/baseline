import type { PlayerPoseFrame, PoseKeypoint, CocoKeypointName } from "./phase2-types";
import type { PaddleObservation } from "./audio-contacts";

/**
 * Where the paddle is, worked out from the arm instead of detected.
 *
 * WHY NOT DETECT IT. Three Roboflow paddle models were tried on this footage
 * and the best of them found a paddle in about 1% of frames. That is not three
 * bad models: a paddle is a thin flat object whose apparent shape changes
 * completely as it rotates, it is edge-on and a few pixels wide for much of a
 * swing, it is motion-blurred exactly at contact, and from behind the baseline
 * the near player's paddle is behind their own body while the far player's is
 * tiny. The camera cannot see the thing. Pose, meanwhile, lands wrist
 * keypoints on the large majority of shots, and a paddle is bolted to a hand.
 *
 * WHAT THIS IS AND IS NOT. This is an ESTIMATE of where the paddle head is,
 * good enough to answer "which player did the ball fly at" -- which is the
 * only question the pipeline ever asked a paddle detector. It is NOT a
 * measurement of the paddle: it cannot tell you the face angle, the swing
 * path, or where on the face the ball hit, and nothing here should ever be
 * presented to a user as if it could. swing.ts is deliberate about not
 * promoting a wrist into a paddle for exactly that reason, and that stays
 * true; this is a different job, feeding a confidence term rather than a
 * coaching claim, and every observation it emits is capped and marked.
 *
 * THE GEOMETRY. The forearm points from elbow to wrist, and at contact the
 * paddle continues roughly along that line -- the wrist is close to neutral
 * through the strike, which is what a coach means by "firm wrist". So:
 *
 *     paddle ≈ wrist + normalise(wrist - elbow) × onePaddleLength
 *
 * with gripLength in SHOULDER WIDTHS, not pixels. A pixel offset would be
 * right for the near player and several times too long for the far one, since
 * the far player images perhaps a third of the size. Shoulder width is the
 * same scale correction the rest of the mechanics code uses.
 */

/** Keypoint confidence below which a joint is not trusted. Matches swing.ts. */
const MIN_KP_CONF = 0.3;

/**
 * How far past the wrist the paddle sits: one paddle length.
 *
 * Expressed in SHOULDER WIDTHS rather than pixels, because the near player
 * images perhaps three times the size of the far one. A pixel offset would put
 * the near player's paddle roughly right and throw the far player's several
 * paddle-lengths off court. Shoulder width is the same scale correction the
 * rest of the mechanics code uses.
 *
 * The number falls out of two real measurements rather than being tuned until
 * the overlay looked nice: a pickleball paddle is about 40 cm from butt to
 * tip, and an adult shoulder width is also about 40 cm. One paddle length is
 * therefore ~1.0 shoulder widths, and the marker lands at the TIP of the
 * paddle -- the end of the object, measured from the hand holding it.
 */
export const PADDLE_LENGTHS_FROM_WRIST = 1.0;

/**
 * Confidence ceiling for an estimated paddle.
 *
 * Deliberately below what a detector would report. This is inferred, the
 * forearm-extension assumption breaks on a wristy roll or a two-handed
 * backhand, and anything downstream weighing a real detection against this one
 * should prefer the real one.
 */
export const ESTIMATE_MAX_CONFIDENCE = 0.45;

interface XY { x: number; y: number }

function kp(frame: PlayerPoseFrame, name: CocoKeypointName): XY | null {
  const k: PoseKeypoint | undefined = frame.keypoints.find((q) => q.name === name);
  if (!k || k.xNorm === null || k.yNorm === null) return null;
  if ((k.confidence ?? 0) < MIN_KP_CONF) return null;
  return { x: k.xNorm, y: k.yNorm };
}

function dist(a: XY, b: XY): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function shoulderWidth(f: PlayerPoseFrame): number | null {
  const l = kp(f, "left_shoulder"), r = kp(f, "right_shoulder");
  if (!l || !r) return null;
  const w = dist(l, r);
  return w > 1e-4 ? w : null;
}

/**
 * Which arm is holding the paddle, in ONE frame.
 *
 * swing.ts decides this across a window by which wrist travels furthest, which
 * is the better answer when a window is available. Here only a single frame is
 * in hand, so the test is which wrist is further from the body centre -- the
 * hitting arm is extended and the other is tucked. Weaker, and the reason this
 * returns null rather than guessing when the two are close: attributing a
 * contact to the wrong hand puts the estimated paddle on the wrong side of the
 * body, which is worse than having no estimate at all.
 */
function hittingWrist(f: PlayerPoseFrame): { wrist: XY; elbow: XY } | null {
  const ls = kp(f, "left_shoulder"), rs = kp(f, "right_shoulder");
  if (!ls || !rs) return null;
  const centre = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };

  // WHICH arm is swinging is decided on wrists alone, BEFORE elbows are
  // required. Deciding it on arms that happen to have both joints readable
  // meant that when the hitting arm's elbow was missing, the tucked arm was
  // the only candidate left and won by default -- putting the estimated
  // paddle on the opposite side of the body from the actual swing. Identify
  // the arm first, then insist on that arm's elbow.
  const wrists = (["left", "right"] as const).map((side) => {
    const wrist = kp(f, `${side}_wrist` as CocoKeypointName);
    return wrist ? { side, wrist, reach: dist(wrist, centre) } : null;
  }).filter((a): a is { side: "left" | "right"; wrist: XY; reach: number } => a !== null);

  if (wrists.length === 0) return null;

  let chosen: { side: "left" | "right"; wrist: XY };
  if (wrists.length === 1) {
    chosen = wrists[0];
  } else {
    const [a, b] = [...wrists].sort((p, q) => q.reach - p.reach);
    // Within 15% of each other is a stance, not a swing. Refuse rather than
    // coin-flip.
    if (a.reach <= b.reach * 1.15) return null;
    chosen = a;
  }

  const elbow = kp(f, `${chosen.side}_elbow` as CocoKeypointName);
  if (!elbow) return null;   // the swinging arm is the only one worth using
  return { wrist: chosen.wrist, elbow };
}

/** The estimate for one pose frame, or null when the arm is not readable. */
export function paddleFromPose(
  f: PlayerPoseFrame,
  paddleLengths = PADDLE_LENGTHS_FROM_WRIST
): PaddleObservation | null {
  const arm = hittingWrist(f);
  if (!arm) return null;
  const sw = shoulderWidth(f);
  if (!sw) return null;

  const dx = arm.wrist.x - arm.elbow.x;
  const dy = arm.wrist.y - arm.elbow.y;
  const len = Math.hypot(dx, dy);
  // A forearm of zero length means the two joints landed on the same pixel,
  // which is a pose failure rather than a pose. There is no direction to
  // extend along, so there is nothing to say.
  if (len < 1e-4) return null;

  // One paddle length out along the forearm, scaled to this player.
  const reach = sw * paddleLengths;
  const x = arm.wrist.x + (dx / len) * reach;
  const y = arm.wrist.y + (dy / len) * reach;

  // Off-frame means the arm pointed out of shot; the paddle may really be
  // there but nothing downstream can use a position that is not in the image.
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;

  return {
    source: "pose",
    // The forearm direction IS the paddle's long axis in the image, and it was
    // already being computed to place the position -- it was simply thrown
    // away. Reporting it costs nothing and lets the overlay draw a paddle
    // pointing where the arm points instead of an axis-aligned square, which
    // is the difference between seeing whether the estimate tracks the swing
    // and seeing a box drift about.
    angleDeg: Math.round((Math.atan2(dy, dx) * 180 / Math.PI) * 10) / 10,
    t: f.timestampSeconds,
    x: Math.round(x * 1e5) / 1e5,
    y: Math.round(y * 1e5) / 1e5,
    // The paddle's real proportions, so the overlay can draw the OBJECT rather
    // than a marker: w is across the face (~20 cm, half a shoulder width), h is
    // butt to tip (~40 cm, one shoulder width). Combined with angleDeg and the
    // tip position in x/y, that is everything needed to place an actual paddle
    // shape on the frame -- and it doubles as the bounding box a detector
    // would have reported, so nothing downstream has to special-case it.
    w: Math.round(sw * 0.5 * 1e5) / 1e5,
    h: Math.round(sw * paddleLengths * 1e5) / 1e5,
    playerId: f.playerId,
    confidence: ESTIMATE_MAX_CONFIDENCE,
  };
}

/**
 * Estimates for every pose frame that supports one.
 *
 * Frames that cannot produce an estimate are simply absent -- there is no
 * placeholder and no interpolation, so a caller counting observations is
 * counting real ones.
 */
export function paddlesFromPoses(
  poses: PlayerPoseFrame[],
  paddleLengths = PADDLE_LENGTHS_FROM_WRIST
): PaddleObservation[] {
  const out: PaddleObservation[] = [];
  for (const f of poses) {
    const p = paddleFromPose(f, paddleLengths);
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.t - b.t);
}

/** `PADDLE_FROM_POSE=off` disables it. On by default. */
export function paddleFromPoseEnabled(): boolean {
  const v = (process.env.PADDLE_FROM_POSE || "on").toLowerCase();
  return v !== "off" && v !== "0" && v !== "false";
}
