/**
 * What a player is shaped like, as a few ratios that clothing cannot change.
 *
 * THE POINT IS THE CASE COLOUR CANNOT HANDLE. Two partners in matching kit are
 * nearly invisible to an appearance signature -- three bands help, but a pair
 * who also happen to have similar hair and similar shoes are back to geometry
 * alone, deciding between two people standing next to each other. Build is a
 * completely independent axis: two people are rarely the same proportions, and
 * no amount of matching kit changes that.
 *
 * FREE, which is why it is worth doing. Detection and pose come out of one
 * model pass (detectPeopleWithPose), so every detection already carries its
 * keypoints before the roster runs. This is arithmetic on numbers that exist.
 *
 * WHAT IT IS NOT: identification. These are coarse proportions measured off a
 * noisy 2D projection of a moving person, good for "these two detections are
 * probably the same of the two people on this side" and nothing beyond it. A
 * player bent into a dig has a foreshortened torso and will read as a
 * different build for that frame, which is why every ratio is normalised, the
 * comparison is loose, and the roster averages it over a whole clip instead of
 * trusting one frame.
 */
import type { CocoKeypointName, PoseKeypoint } from "./phase2-types";

export interface BuildSignature {
  /** Shoulder width over torso length. Broad-and-short vs narrow-and-long. */
  shoulderToTorso: number;
  /** Hip-to-ankle over torso length. Long-legged vs long-bodied. */
  legToTorso: number;
  /** Head height over torso length. Weakest of the three; children aside, it varies less. */
  headToTorso: number | null;
}

/**
 * How sure a keypoint must be to be measured from.
 *
 * Higher than the 0.3 used for drawing. A limb drawn slightly wrong is a
 * cosmetic problem; a hip guessed slightly wrong changes a ratio, and the
 * ratio is being used to decide who somebody is.
 */
const MIN_KP_CONFIDENCE = 0.5;

/**
 * The shortest torso worth measuring, as a fraction of frame height.
 *
 * Below this the joint positions are a handful of pixels apart and the ratios
 * are mostly quantisation noise -- which matters because the far pair of
 * players are exactly the small ones.
 */
const MIN_TORSO_NORM = 0.04;

type Pt = { x: number; y: number };

function pick(kps: PoseKeypoint[], name: CocoKeypointName): Pt | null {
  const k = kps.find((p) => p.name === name);
  if (!k || k.xNorm === null || k.yNorm === null) return null;
  if ((k.confidence ?? 0) < MIN_KP_CONFIDENCE) return null;
  return { x: k.xNorm, y: k.yNorm };
}

function mid(a: Pt | null, b: Pt | null): Pt | null {
  if (a && b) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return a ?? b;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The build ratios for one detection, or null when too little of the body was seen. */
export function buildSignatureFrom(keypoints: PoseKeypoint[]): BuildSignature | null {
  const ls = pick(keypoints, "left_shoulder");
  const rs = pick(keypoints, "right_shoulder");
  const lh = pick(keypoints, "left_hip");
  const rh = pick(keypoints, "right_hip");
  const shoulders = mid(ls, rs);
  const hips = mid(lh, rh);
  if (!shoulders || !hips) return null;

  const torso = dist(shoulders, hips);
  if (torso < MIN_TORSO_NORM) return null;

  // BOTH shoulders, not one and an inferred midpoint: a width measured from a
  // midpoint that IS one of the two shoulders is not a width at all.
  if (!ls || !rs) return null;
  const shoulderToTorso = dist(ls, rs) / torso;

  const ankles = mid(pick(keypoints, "left_ankle"), pick(keypoints, "right_ankle"));
  // Feet are the first thing the net, the kitchen line or another player hides,
  // so a missing leg ratio is ordinary rather than exceptional. Without it the
  // signature is still worth having.
  if (!ankles) return null;
  const legToTorso = dist(hips, ankles) / torso;

  const nose = pick(keypoints, "nose");
  const headToTorso = nose ? dist(nose, shoulders) / torso : null;

  // A ratio far outside what a human body can produce means the pose is wrong,
  // not that somebody is unusual -- most often two people's joints merged into
  // one skeleton during an overlap. Filed as no reading rather than a strange
  // one, because a strange reading is what drags an average off.
  // An adult's shoulders are a little narrower than their shoulder-to-hip
  // length, so the ratio sits near 0.9 standing square to the camera. Looking
  // down at a player, or catching one bent forward for a dig, foreshortens the
  // torso and pushes it up -- 2.5 leaves room for a good deal of that and
  // still rejects the merged-skeleton case, where two people's joints become
  // one impossibly wide figure. A frame where somebody is bent double is not a
  // measurement of their shape either, so losing those is no loss.
  if (shoulderToTorso < 0.2 || shoulderToTorso > 2.5) return null;
  if (legToTorso < 0.4 || legToTorso > 5) return null;

  return { shoulderToTorso, legToTorso, headToTorso };
}

/**
 * 0 (same build) upward, in the same rough units as appearanceDistance.
 *
 * Each ratio's difference is divided by a spread that is roughly what a real
 * population varies by, so a typical pair of different people lands near 1 and
 * the same person across two frames lands near 0. Nothing is clamped at the
 * bottom: two people who genuinely are the same shape should score zero and
 * let the other cues decide, rather than manufacturing a difference.
 */
const SPREADS = { shoulderToTorso: 0.35, legToTorso: 0.5, headToTorso: 0.3 };

export function buildDistance(a: BuildSignature, b: BuildSignature): number {
  let sum = Math.abs(a.shoulderToTorso - b.shoulderToTorso) / SPREADS.shoulderToTorso
    + Math.abs(a.legToTorso - b.legToTorso) / SPREADS.legToTorso;
  let terms = 2;
  if (a.headToTorso !== null && b.headToTorso !== null) {
    sum += Math.abs(a.headToTorso - b.headToTorso) / SPREADS.headToTorso;
    terms += 1;
  }
  return Math.min(1, sum / terms);
}

/** A running mean, so one frame of a player mid-dive cannot define their build. */
export function blendBuild(a: BuildSignature, b: BuildSignature, w: number): BuildSignature {
  const mixHead = a.headToTorso !== null && b.headToTorso !== null
    ? a.headToTorso * (1 - w) + b.headToTorso * w
    : (b.headToTorso ?? a.headToTorso);
  return {
    shoulderToTorso: a.shoulderToTorso * (1 - w) + b.shoulderToTorso * w,
    legToTorso: a.legToTorso * (1 - w) + b.legToTorso * w,
    headToTorso: mixHead,
  };
}
