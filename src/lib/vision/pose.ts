import { estimatePoseViaPython } from "./cv-scripts";
import type { BoundingBoxNorm, CocoKeypointName, PlayerPoseFrame, PlayerTrack } from "./phase2-types";

function iou(a: BoundingBoxNorm, b: BoundingBoxNorm): number {
  const ax2 = a.x + a.width, ay2 = a.y + a.height;
  const bx2 = b.x + b.width, by2 = b.y + b.height;
  const ix1 = Math.max(a.x, b.x), iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Runs YOLOv8n-pose on a batch of frames (one Python process, model loaded
 * once) and assigns each detected person to the track whose box at that
 * timestamp best overlaps it — pose estimation itself doesn't know about
 * player identity, tracking already solved that, so this just links the
 * two outputs by geometry. A pose with no sufficiently-overlapping track
 * (IoU < 0.2) is dropped rather than guessing which player it belongs to.
 */
export async function estimatePosesForFrames(
  frames: Array<{ path: string; timestampSeconds: number }>,
  tracks: PlayerTrack[]
): Promise<PlayerPoseFrame[]> {
  if (frames.length === 0) return [];
  const results = await estimatePoseViaPython(frames.map((f) => f.path));

  const results_by_path = new Map(results.map((r) => [r.imagePath, r]));
  const output: PlayerPoseFrame[] = [];

  for (const frame of frames) {
    const raw = results_by_path.get(frame.path);
    if (!raw || raw.error) continue;

    for (const person of raw.people) {
      let bestTrack: PlayerTrack | null = null;
      let bestScore = 0;
      for (const track of tracks) {
        const point = track.points.find((p) => p.timestampSeconds === frame.timestampSeconds);
        if (!point) continue;
        const score = iou(point.boxImageNorm, person.boxImageNorm);
        if (score > bestScore) {
          bestScore = score;
          bestTrack = track;
        }
      }
      if (!bestTrack || bestScore < 0.2) continue;

      output.push({
        playerId: bestTrack.playerId,
        timestampSeconds: frame.timestampSeconds,
        detectionConfidence: person.detectionConfidence,
        keypoints: person.keypoints.map((k) => ({
          name: k.name as CocoKeypointName,
          xNorm: k.xNorm,
          yNorm: k.yNorm,
          confidence: k.confidence,
        })),
        modelSource: "yolov8n-pose",
      });
    }
  }

  return output;
}
