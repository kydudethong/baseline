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
/**
 * The most pose frames one run will pay for.
 *
 * THIS CAP IS NEW BECAUSE THE STAGE IS NEW. Pose has been in the pipeline for
 * weeks and has not actually RUN on the server for any of them: an ultralytics
 * warning on stdout made the caller's JSON.parse throw, the whole pass returned
 * nothing, and it did so instantly. Fixing that turned a stage that cost
 * nothing into a stage that does the real work -- and the real work on a
 * 13.7-minute clip is 4,121 frames of CPU inference on a box with no
 * accelerator, which is somewhere between seven and thirty minutes.
 *
 * So: a bound, and an honest one. Past this many frames the clip is SAMPLED --
 * an even spread end to end rather than the first N, so a long game gets
 * skeletons throughout rather than for its first four minutes and nothing
 * after. The overlay's skeletons get sparser on a long clip, and that is the
 * trade: a sparse figure on a run that finishes beats a dense one on a run
 * that dies at minute twelve.
 *
 * POSE_MAX_FRAMES tunes it. 0 means no cap, for a box that can afford it.
 */
export const POSE_MAX_FRAMES = 1800;

export function poseMaxFrames(): number {
  const v = Number(process.env.POSE_MAX_FRAMES);
  return Number.isFinite(v) && v >= 0 ? v : POSE_MAX_FRAMES;
}

/** An even spread of n items across a list, first and last included. */
function spread<T>(items: T[], n: number): T[] {
  if (n <= 0 || items.length <= n) return items;
  if (n === 1) return [items[0]];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}

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

  const cap = poseMaxFrames();
  const requested = frames.length;
  const toRead = cap > 0 ? spread([...frames], cap) : frames;
  if (toRead.length < requested) {
    onLog?.(
      `pose: ${requested} sampled frame(s) is past the ${cap}-frame budget, so ${toRead.length} are read, `
      + `spread across the whole clip (about one every ${
        ((frames[frames.length - 1].timestampSeconds - frames[0].timestampSeconds) / toRead.length).toFixed(2)
      }s). Skeletons will be sparser than on a short clip.`
    );
  }
  frames = toRead;

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
  let firstError = "";
  let peopleSeen = 0;
  let unmatchedNoPoint = 0;
  let unmatchedLowOverlap = 0;
  let bestRejectedIou = 0;

  for (const frame of frames) {
    const raw = results_by_path.get(frame.path);
    if (!raw) { framesMissing++; continue; }
    if (raw.error) {
      framesErrored++;
      if (!firstError) firstError = String(raw.error);
      continue;
    }

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

  // EMPTY IS A FAILURE, NOT A RESULT -- and this is the line whose absence
  // cost a week.
  //
  // estimate_pose.py reports a bad batch as DATA: one {"error": ...} per
  // frame, exit code 0. So a missing weights file, a torch that will not load,
  // an out-of-memory kill mid-batch -- every one of them arrived here as a
  // perfectly successful run that happened to find nobody, and travelled all
  // the way to a finished analysis showing "Pose rows: 0" with nothing
  // anywhere saying why. The overlay had no skeletons on it and the honest
  // conclusion from outside was that the DRAWING was broken.
  //
  // So: if the model errored on every frame it was given, that is thrown. The
  // caller turns it into a limitation the run reports, carrying the Python
  // error itself rather than a count.
  if (frames.length > 0 && framesErrored === frames.length) {
    throw new Error(
      `the pose model failed on all ${frames.length} frame(s): ${firstError || "no error text returned"}`
    );
  }

  return output;
}
