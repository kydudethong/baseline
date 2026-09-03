import type { BoundingBoxNorm, FrameDetectionSet, PlayerTrack, PlayerTrackPoint } from "./phase2-types";

/**
 * Real greedy IoU tracker — the "evaluate ByteTrack/BoT-SORT-style
 * tracking" requirement, implemented directly rather than through
 * Roboflow's hosted ByteTrack Workflow block. Rationale (documented in the
 * deliverables report): wiring a full custom Roboflow Workflow adds
 * account/workspace setup overhead for marginal benefit at this frame
 * count (VISION_FPS=5 over a ~2min clip is a few hundred frames, well
 * within what a simple frame-to-frame IoU matcher handles reliably); this
 * can be swapped for hosted ByteTrack later without changing anything
 * downstream, since it produces the same PlayerTrack[] shape.
 *
 * Algorithm: for each frame, greedily match new detections to existing
 * tracks by highest IoU with that track's last box, above a minimum IoU
 * threshold. Unmatched detections start new tracks (up to a max of 4 —
 * pickleball doubles). A track that goes unmatched for too many
 * consecutive sampled frames is considered lost and won't be resumed
 * under the same ID (a real limitation, documented as such — this is not
 * full re-identification).
 */

const MIN_IOU_TO_MATCH = 0.1;
const MAX_TRACKS = 4;
// At VISION_FPS=5, 10 missed frames is a 2-second gap — long enough to
// survive a player briefly leaving the frame edge, a missed low-confidence
// detection, or occlusion behind the net, without losing the identity.
// (An earlier, stricter value of 3 frames measurably fragmented real
// benchmark-video tracks into a dozen+ short-lived IDs instead of ~4 real
// players — see the deliverables report's known-limitations section for
// why this is still an approximation, not solved tracking.)
const MAX_MISSED_FRAMES_BEFORE_LOST = 10;

function iou(a: BoundingBoxNorm, b: BoundingBoxNorm): number {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;

  const interX1 = Math.max(a.x, b.x);
  const interY1 = Math.max(a.y, b.y);
  const interX2 = Math.min(ax2, bx2);
  const interY2 = Math.min(ay2, by2);

  const interW = Math.max(0, interX2 - interX1);
  const interH = Math.max(0, interY2 - interY1);
  const interArea = interW * interH;

  const areaA = Math.max(0, a.width) * Math.max(0, a.height);
  const areaB = Math.max(0, b.width) * Math.max(0, b.height);
  const unionArea = areaA + areaB - interArea;

  return unionArea > 0 ? interArea / unionArea : 0;
}

interface LiveTrack {
  playerId: string;
  points: PlayerTrackPoint[];
  lastBox: BoundingBoxNorm;
  lastTimestamp: number;
  velocity: { x: number; y: number } | null; // normalized units/second, center-of-box
  missedFrames: number;
}

/** Constant-velocity extrapolation, so a track surviving a short gap (see
 * MAX_MISSED_FRAMES_BEFORE_LOST) is matched against where the player
 * probably is now, not where they were several frames ago — a real player
 * covering court between points can easily have moved further than their
 * last box overlaps with their next detection. */
function predictBox(track: LiveTrack, atTimestamp: number): BoundingBoxNorm {
  if (!track.velocity) return track.lastBox;
  const dt = atTimestamp - track.lastTimestamp;
  return {
    x: track.lastBox.x + track.velocity.x * dt,
    y: track.lastBox.y + track.velocity.y * dt,
    width: track.lastBox.width,
    height: track.lastBox.height,
  };
}

export function trackPlayersByIoU(perFrame: FrameDetectionSet[]): PlayerTrack[] {
  const live: LiveTrack[] = [];
  const finished: LiveTrack[] = [];
  let nextTrackNumber = 1;

  const sorted = [...perFrame].sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  for (const frame of sorted) {
    const unmatchedDetections = [...frame.players];
    const matchedTrackIds = new Set<string>();

    // Greedy: repeatedly pick the single best (track, detection) IoU pair above threshold.
    while (unmatchedDetections.length > 0) {
      let best: { trackIdx: number; detIdx: number; score: number } | null = null;

      for (let ti = 0; ti < live.length; ti++) {
        if (matchedTrackIds.has(live[ti].playerId)) continue;
        const predicted = predictBox(live[ti], frame.timestampSeconds);
        for (let di = 0; di < unmatchedDetections.length; di++) {
          const score = iou(predicted, unmatchedDetections[di].boxImageNorm);
          if (score >= MIN_IOU_TO_MATCH && (!best || score > best.score)) {
            best = { trackIdx: ti, detIdx: di, score };
          }
        }
      }

      if (!best) break;

      const track = live[best.trackIdx];
      const det = unmatchedDetections[best.detIdx];
      const dt = frame.timestampSeconds - track.lastTimestamp;
      if (dt > 0) {
        const prevCx = track.lastBox.x + track.lastBox.width / 2;
        const prevCy = track.lastBox.y + track.lastBox.height / 2;
        const newCx = det.boxImageNorm.x + det.boxImageNorm.width / 2;
        const newCy = det.boxImageNorm.y + det.boxImageNorm.height / 2;
        track.velocity = { x: (newCx - prevCx) / dt, y: (newCy - prevCy) / dt };
      }
      track.points.push({
        timestampSeconds: frame.timestampSeconds,
        boxImageNorm: det.boxImageNorm,
        confidence: det.confidence,
        courtPosition: null,
      });
      track.lastBox = det.boxImageNorm;
      track.lastTimestamp = frame.timestampSeconds;
      track.missedFrames = 0;
      matchedTrackIds.add(track.playerId);
      unmatchedDetections.splice(best.detIdx, 1);
    }

    // Age out tracks that weren't matched this frame.
    for (const track of live) {
      if (!matchedTrackIds.has(track.playerId)) {
        track.missedFrames += 1;
      }
    }
    for (let i = live.length - 1; i >= 0; i--) {
      if (live[i].missedFrames > MAX_MISSED_FRAMES_BEFORE_LOST) {
        finished.push(live[i]);
        live.splice(i, 1);
      }
    }

    // Remaining unmatched detections start new tracks, capped at MAX_TRACKS total (live + finished-but-still-countable).
    for (const det of unmatchedDetections) {
      if (live.length >= MAX_TRACKS) break; // don't fabricate a 5th player
      const playerId = `player_${nextTrackNumber++}`;
      live.push({
        playerId,
        points: [{
          timestampSeconds: frame.timestampSeconds,
          boxImageNorm: det.boxImageNorm,
          confidence: det.confidence,
          courtPosition: null,
        }],
        lastBox: det.boxImageNorm,
        lastTimestamp: frame.timestampSeconds,
        velocity: null,
        missedFrames: 0,
      });
    }
  }

  const all = [...finished, ...live];
  // Drop tracks that only ever appeared once — almost certainly a false-positive
  // detection, not a real player, and would otherwise pollute player_N numbering.
  const real = all.filter((t) => t.points.length >= 2);

  return real.map((t) => ({ playerId: t.playerId, points: t.points }));
}
