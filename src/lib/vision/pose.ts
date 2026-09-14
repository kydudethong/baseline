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

/** The track's own box at (or nearest to) a time, within a tolerance. */
/**
 * How far a track sample may be from a pose frame and still be the same
 * moment.
 *
 * WAS ZERO, meaning exact floating-point equality between two timestamps that
 * travel through different code paths before they meet. When that holds it is
 * luck rather than design, and when it does not the whole pose pass silently
 * produces nothing -- no error, no log line, just an overlay with no skeletons
 * on it and a coaching pass with no mechanics.
 *
 * 40ms is far tighter than the gap between sampled frames (200ms at the 5fps
 * baseline) so it can never match the wrong sample, and far looser than any
 * rounding that might have crept in.
 */
const DEFAULT_MATCH_TOLERANCE_S = 0.04;

/**
 * Minimum box overlap to call a pose and a track the same person.
 *
 * Named rather than inlined because it appears in the diagnostic above, and a
 * threshold you can see next to the value that failed it is worth far more
 * than one buried in a comparison.
 */
const MIN_IOU = 0.2;

function nearestPoint(track: PlayerTrack, t: number, toleranceS: number) {
  if (toleranceS <= 0) return track.points.find((p) => p.timestampSeconds === t);
  let best: PlayerTrack["points"][number] | undefined;
  let bestDt = Infinity;
  for (const p of track.points) {
    const dt = Math.abs(p.timestampSeconds - t);
    if (dt <= toleranceS && dt < bestDt) { bestDt = dt; best = p; }
  }
  return best;
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
  tracks: PlayerTrack[],
  /**
   * How far in time a track point may be from the frame and still be the one
   * this pose belongs to. Zero keeps the original exact-timestamp rule, which
   * is right for frames sampled on the track's own grid. Burst frames are
   * extracted at contact times and land BETWEEN track samples, so they need a
   * tolerance or every pose in a burst is silently dropped.
   */
  matchToleranceS = DEFAULT_MATCH_TOLERANCE_S,
  onLog?: (line: string) => void
): Promise<PlayerPoseFrame[]> {
  if (frames.length === 0) return [];
  const results = await estimatePoseViaPython(frames.map((f) => f.path));

  const results_by_path = new Map(results.map((r) => [r.imagePath, r]));
  const output: PlayerPoseFrame[] = [];

  // COUNTERS, because "no skeletons in the overlay" had three possible causes
  // and no way to tell them apart from the outside: the pose model found
  // nobody, it found people but none of them lined up with a track, or the
  // matching lined them up and something later dropped them. Each needs a
  // different fix and the run said nothing about which it was.
  let framesMissing = 0;
  let framesErrored = 0;
  let peopleSeen = 0;
  let unmatchedNoPoint = 0;
  let unmatchedLowOverlap = 0;
  let bestRejectedIou = 0;

  for (const frame of frames) {
    const raw = results_by_path.get(frame.path);
    if (!raw) { framesMissing++; continue; }
    if (raw.error) { framesErrored++; continue; }

    for (const person of raw.people) {
      peopleSeen++;
      let bestTrack: PlayerTrack | null = null;
      let bestScore = 0;
      let anyPoint = false;
      for (const track of tracks) {
        const point = nearestPoint(track, frame.timestampSeconds, matchToleranceS);
        if (!point) continue;
        anyPoint = true;
        const score = iou(point.boxImageNorm, person.boxImageNorm);
        if (score > bestScore) {
          bestScore = score;
          bestTrack = track;
        }
      }
      if (!anyPoint) { unmatchedNoPoint++; continue; }
      if (!bestTrack || bestScore < MIN_IOU) {
        unmatchedLowOverlap++;
        bestRejectedIou = Math.max(bestRejectedIou, bestScore);
        continue;
      }

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

  onLog?.(
    `pose: ${peopleSeen} person detection(s) across ${frames.length} frame(s) -> ${output.length} matched to a track`
    + (unmatchedNoPoint ? `; ${unmatchedNoPoint} had no track sample within ${matchToleranceS}s` : "")
    + (unmatchedLowOverlap
      ? `; ${unmatchedLowOverlap} overlapped no track well enough (best ${bestRejectedIou.toFixed(2)}, need ${MIN_IOU})`
      : "")
    + (framesMissing ? `; ${framesMissing} frame(s) missing from the pose output` : "")
    + (framesErrored ? `; ${framesErrored} frame(s) the pose model failed on` : "")
  );
  return output;
}
