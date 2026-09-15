/**
 * The COCO 17-keypoint skeleton: which joints connect to which.
 *
 * One definition, used by both the still-frame overlay and the video overlay,
 * because two hand-maintained bone lists drift and then the two views of the
 * same pose disagree.
 *
 * Grouped by limb rather than listed flat. A swing is an arm doing something
 * while the legs and trunk do something else, so being able to colour or
 * reason about one limb at a time is the point of drawing this at all -- a
 * uniform green stick figure shows you that pose ran, not what the body did.
 */
export type CocoName =
  | "nose" | "left_eye" | "right_eye" | "left_ear" | "right_ear"
  | "left_shoulder" | "right_shoulder" | "left_elbow" | "right_elbow"
  | "left_wrist" | "right_wrist" | "left_hip" | "right_hip"
  | "left_knee" | "right_knee" | "left_ankle" | "right_ankle";

export type LimbGroup = "head" | "torso" | "armLeft" | "armRight" | "legLeft" | "legRight";

export interface Bone {
  from: CocoName;
  to: CocoName;
  group: LimbGroup;
}

export const SKELETON: Bone[] = [
  // Head
  { from: "left_ear", to: "left_eye", group: "head" },
  { from: "left_eye", to: "nose", group: "head" },
  { from: "nose", to: "right_eye", group: "head" },
  { from: "right_eye", to: "right_ear", group: "head" },
  // Trunk: shoulders and hips as a closed quad reads as a body, where four
  // separate lines read as scaffolding.
  { from: "left_shoulder", to: "right_shoulder", group: "torso" },
  { from: "left_shoulder", to: "left_hip", group: "torso" },
  { from: "right_shoulder", to: "right_hip", group: "torso" },
  { from: "left_hip", to: "right_hip", group: "torso" },
  // Arms -- the paddle arm is the whole reason this is drawn.
  { from: "left_shoulder", to: "left_elbow", group: "armLeft" },
  { from: "left_elbow", to: "left_wrist", group: "armLeft" },
  { from: "right_shoulder", to: "right_elbow", group: "armRight" },
  { from: "right_elbow", to: "right_wrist", group: "armRight" },
  // Legs
  { from: "left_hip", to: "left_knee", group: "legLeft" },
  { from: "left_knee", to: "left_ankle", group: "legLeft" },
  { from: "right_hip", to: "right_knee", group: "legRight" },
  { from: "right_knee", to: "right_ankle", group: "legRight" },
];

/**
 * Limb colours.
 *
 * The paddle arm is what a coach looks at, so the arms are the brightest thing
 * on the figure and the two sides are told apart at a glance -- a single-colour
 * skeleton makes a backhand and a forehand look identical in a still.
 */
export const LIMB_COLOUR: Record<LimbGroup, string> = {
  head: "#9aa8bb",
  torso: "#5ce08c",
  armRight: "#ffd23a",   // paddle side for a right-hander
  armLeft: "#3aa0ff",
  legRight: "#8fe3b0",
  legLeft: "#7fc4ff",
};

/** Below this a keypoint is a guess, and joining guesses draws limbs that never existed. */
export const MIN_KEYPOINT_CONFIDENCE = 0.3;

export interface KeypointLike {
  name: string;
  xNorm: number | null;
  yNorm: number | null;
  confidence: number | null;
}

/** Bones whose BOTH ends were actually seen, in draw order. */
export function visibleBones(
  keypoints: KeypointLike[],
  minConfidence = MIN_KEYPOINT_CONFIDENCE
): Array<{ from: [number, number]; to: [number, number]; group: LimbGroup }> {
  const by = new Map<string, KeypointLike>();
  for (const k of keypoints) by.set(k.name, k);
  // IN THE FRAME, as well as confident.
  //
  // YOLO's pose head does not clamp what it regresses, so a joint it is unsure
  // about can come back at a coordinate outside the picture -- and its
  // confidence is not always low enough to catch. Joining one of those to a
  // real shoulder draws a limb running off the corner of the image, which is
  // what the stretched lines on every head were. A keypoint outside the frame
  // was not seen in the frame.
  //
  // Belt and braces: estimate_pose.py nulls these at the source now. This is
  // the same check one layer up, because the still-frame overlay and the video
  // overlay both read pose data that may have been stored before that fix.
  const inFrame = (v: number) => v >= -0.02 && v <= 1.02;
  // (0, 0) is a SENTINEL, not a location: YOLO returns the origin for a
  // keypoint it did not place, and the origin is perfectly in-frame, so the
  // bounds test above sails straight past it. That is the one that showed --
  // an undetected eye became a point in the top-left corner and the bone to
  // the nose drew a line across the picture. A real joint at the exact corner
  // pixel does not happen in footage of a court.
  const atOrigin = (x: number, y: number) => Math.abs(x) < 1e-4 && Math.abs(y) < 1e-4;
  const ok = (k: KeypointLike | undefined): k is KeypointLike =>
    !!k && k.xNorm !== null && k.yNorm !== null
    && inFrame(k.xNorm) && inFrame(k.yNorm)
    && !atOrigin(k.xNorm, k.yNorm)
    && (k.confidence ?? 0) >= minConfidence;

  const out: Array<{ from: [number, number]; to: [number, number]; group: LimbGroup }> = [];
  for (const b of SKELETON) {
    const a = by.get(b.from);
    const c = by.get(b.to);
    if (!ok(a) || !ok(c)) continue;
    out.push({ from: [a.xNorm!, a.yNorm!], to: [c.xNorm!, c.yNorm!], group: b.group });
  }
  return out;
}
