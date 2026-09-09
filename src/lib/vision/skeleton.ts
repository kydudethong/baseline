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
  const ok = (k: KeypointLike | undefined): k is KeypointLike =>
    !!k && k.xNorm !== null && k.yNorm !== null && (k.confidence ?? 0) >= minConfidence;

  const out: Array<{ from: [number, number]; to: [number, number]; group: LimbGroup }> = [];
  for (const b of SKELETON) {
    const a = by.get(b.from);
    const c = by.get(b.to);
    if (!ok(a) || !ok(c)) continue;
    out.push({ from: [a.xNorm!, a.yNorm!], to: [c.xNorm!, c.yNorm!], group: b.group });
  }
  return out;
}
