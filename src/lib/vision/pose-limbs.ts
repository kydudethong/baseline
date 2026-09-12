/**
 * Drop joints that would draw a limb longer than the player's own limb is.
 *
 * THE FAILURE THIS CATCHES. Ky described it exactly: joints fly off and limbs
 * stretch wrong. The skeleton is on the right person and mostly right, but one
 * frame puts a wrist somewhere that would need a three-foot forearm.
 *
 * WHY NOT SMOOTHING, WHICH ALREADY EXISTS. pose-smooth.ts compares a frame to
 * its NEIGHBOURS IN TIME, so it needs them close together -- it only works
 * inside the high-rate bursts. At the 5fps baseline, samples are 200ms apart
 * and a real wrist can genuinely travel further in that time than a glitch
 * does, so displacement carries no signal at all there. The information is not
 * in the data. This check is different in kind: it compares a frame to
 * ITSELF, so it works identically at 5fps and 30fps.
 *
 * THE ASYMMETRY THAT MAKES IT RIGOROUS. A bone has a fixed length in 3D, and
 * projecting it onto an image can only ever make it look SHORTER -- a forearm
 * pointed at the camera is a few pixels long, which is correct and common. It
 * can never look longer than its true length. So a bone that is too short is
 * evidence of nothing, and one that is too long is geometrically impossible.
 * This gates on the long side only, which is why it can be strict without
 * throwing away real foreshortened poses.
 *
 * The reference length is the player's own 90th-percentile observed bone,
 * measured over the whole clip: near its true 3D length (the frames where the
 * limb lay flat to the camera), and a percentile rather than the maximum so
 * that one bad frame cannot define the budget that would then excuse it.
 */
import type { CocoKeypointName, PlayerPoseFrame, PoseKeypoint } from "./phase2-types";

/** Proximal joint, distal joint. The distal one is what gets dropped. */
const BONES: Array<[CocoKeypointName, CocoKeypointName]> = [
  ["left_shoulder", "left_elbow"],
  ["left_elbow", "left_wrist"],
  ["right_shoulder", "right_elbow"],
  ["right_elbow", "right_wrist"],
  ["left_hip", "left_knee"],
  ["left_knee", "left_ankle"],
  ["right_hip", "right_knee"],
  ["right_knee", "right_ankle"],
];

/**
 * How far past the reference length a bone may go before the distal joint is
 * disbelieved.
 *
 * 1.6 is deliberately loose. The reference is a percentile rather than a
 * measured anatomy, the player moves toward and away from the camera so their
 * apparent size changes through the clip, and a wrongly dropped joint costs a
 * real measurement. The glitch this targets overshoots by far more than 60%.
 */
const MAX_STRETCH = 1.6;

const MIN_CONFIDENCE = 0.3;
/** Below this many observations a percentile is not a measurement. */
const MIN_SAMPLES = 8;

function dist(a: PoseKeypoint, b: PoseKeypoint): number | null {
  if (a.xNorm === null || a.yNorm === null || b.xNorm === null || b.yNorm === null) return null;
  if ((a.confidence ?? 0) < MIN_CONFIDENCE || (b.confidence ?? 0) < MIN_CONFIDENCE) return null;
  return Math.hypot(a.xNorm - b.xNorm, a.yNorm - b.yNorm);
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface LimbGateStats {
  /** Distal joints dropped as geometrically impossible. */
  dropped: number;
  /** Bones that never got enough observations to judge, so were left alone. */
  unmeasured: number;
}

/**
 * Returns new frames with impossible distal joints blanked, plus what it did.
 *
 * A dropped joint becomes null with zero confidence rather than being deleted,
 * so every consumer that already handles "the model did not see this" handles
 * this too, with no new case to get wrong. Pure; never mutates the input.
 */
export function gateImplausibleLimbs(
  frames: PlayerPoseFrame[]
): { frames: PlayerPoseFrame[]; stats: LimbGateStats } {
  const stats: LimbGateStats = { dropped: 0, unmeasured: 0 };

  const byPlayer = new Map<string, PlayerPoseFrame[]>();
  for (const f of frames) {
    const list = byPlayer.get(f.playerId);
    if (list) list.push(f);
    else byPlayer.set(f.playerId, [f]);
  }

  const out: PlayerPoseFrame[] = [];
  for (const [, list] of byPlayer) {
    // Reference length per bone, from this player's own clip. Never shared
    // between players: they are different sizes and different distances from
    // the camera.
    const reference = new Map<string, number>();
    for (const [p, d] of BONES) {
      const lengths: number[] = [];
      for (const f of list) {
        const a = f.keypoints.find((k) => k.name === p);
        const b = f.keypoints.find((k) => k.name === d);
        if (!a || !b) continue;
        const len = dist(a, b);
        if (len !== null && len > 0) lengths.push(len);
      }
      if (lengths.length < MIN_SAMPLES) {
        stats.unmeasured++;
        continue;
      }
      lengths.sort((x, y) => x - y);
      reference.set(`${p}->${d}`, percentile(lengths, 0.9));
    }

    for (const f of list) {
      const blank = new Set<CocoKeypointName>();
      for (const [p, d] of BONES) {
        const ref = reference.get(`${p}->${d}`);
        if (ref === undefined) continue;
        const a = f.keypoints.find((k) => k.name === p);
        const b = f.keypoints.find((k) => k.name === d);
        if (!a || !b) continue;
        const len = dist(a, b);
        if (len !== null && len > ref * MAX_STRETCH) blank.add(d);
      }
      if (blank.size === 0) {
        out.push(f);
        continue;
      }
      stats.dropped += blank.size;
      out.push({
        ...f,
        keypoints: f.keypoints.map((k) =>
          blank.has(k.name) ? { ...k, xNorm: null, yNorm: null, confidence: 0 } : k
        ),
      });
    }
  }
  return { frames: out, stats };
}
