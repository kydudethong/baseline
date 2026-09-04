import type { AppearanceSignature, BoundingBoxNorm, FrameDetectionSet, PlayerTrack, PlayerTrackPoint } from "./phase2-types";

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
 * pickleball doubles).
 *
 * Re-identification: a track that goes unmatched for MAX_MISSED_FRAMES_
 * BEFORE_LOST no longer takes part in IoU matching (its position estimate
 * is too stale to trust), but isn't discarded outright — it moves to a
 * "recently lost" pool and stays eligible to be resumed under its original
 * ID, by appearance alone (color signature, see appearance_signature.py),
 * for up to RECENTLY_LOST_MAX_GAP_SECONDS more. This is still an
 * approximation, not solved tracking: it only works for detections that
 * carry an appearanceSignature (best-effort, can be absent — see
 * run-vision-pipeline.ts), and two players in similar-colored shirts can
 * still be swapped or fail to re-link. Documented as such in the
 * deliverables report's known-limitations section.
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

// How much longer (in video time, not frame count -- sampled frames may
// not be perfectly evenly spaced) a track stays eligible for appearance-
// based re-identification after it's no longer IoU-matchable. 8s at
// VISION_FPS=5 is a generous window for "player walked off past the
// baseline to fetch a ball and came back" without keeping stale identities
// around forever.
const RECENTLY_LOST_MAX_GAP_SECONDS = 8;

// Composite appearance distance below which a revived detection is trusted
// to continue a recently-lost track. Deliberately conservative (a false
// re-link silently merges two different players' movement data) -- see
// appearanceDistance() for how this is weighted.
const APPEARANCE_MATCH_MAX_DISTANCE = 0.25;

/**
 * Weighted HSV distance, 0 (identical) to ~1 (maximally different). Hue is
 * weighted heaviest since it's the most discriminative & lighting-robust
 * cue for "what color shirt", matching the rationale in
 * appearance_signature.py; saturation and value are supporting signals
 * only, since both drift with shadow/sun on an outdoor court.
 */
function appearanceDistance(a: AppearanceSignature, b: AppearanceSignature): number {
  const rawHueDiff = Math.abs(a.h - b.h);
  const hueDiff = Math.min(rawHueDiff, 360 - rawHueDiff) / 180; // 0-1
  const satDiff = Math.abs(a.s - b.s);
  const valDiff = Math.abs(a.v - b.v);
  return 0.6 * hueDiff + 0.25 * satDiff + 0.15 * valDiff;
}

/** Exponential moving average of a track's appearance signature, so one
 * odd-lighting frame doesn't permanently corrupt it, but it still adapts
 * slowly (a player's shirt doesn't change color, but shadow/sun does). */
function emaAppearance(
  prev: AppearanceSignature | null,
  next: AppearanceSignature,
  alpha = 0.3
): AppearanceSignature {
  if (!prev) return next;
  const prevRad = (prev.h * Math.PI) / 180;
  const nextRad = (next.h * Math.PI) / 180;
  const x = (1 - alpha) * Math.cos(prevRad) + alpha * Math.cos(nextRad);
  const y = (1 - alpha) * Math.sin(prevRad) + alpha * Math.sin(nextRad);
  let hue = (Math.atan2(y, x) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return {
    h: hue,
    s: (1 - alpha) * prev.s + alpha * next.s,
    v: (1 - alpha) * prev.v + alpha * next.v,
  };
}

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
  /** EMA of appearanceSignature across matched detections; null if none ever carried one. */
  appearance: AppearanceSignature | null;
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
  // Tracks that aged out of `live` (see MAX_MISSED_FRAMES_BEFORE_LOST) but
  // still carry an appearance signature, and so remain eligible to be
  // resumed under their original ID -- see RECENTLY_LOST_MAX_GAP_SECONDS.
  const recentlyLost: LiveTrack[] = [];
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
      if (det.appearanceSignature) {
        track.appearance = emaAppearance(track.appearance, det.appearanceSignature);
      }
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
        const track = live[i];
        live.splice(i, 1);
        // Only worth keeping around for re-identification if it has a
        // color signature to match against -- otherwise there's nothing
        // to re-identify it BY, so it goes straight to finished exactly
        // as before this feature existed.
        if (track.appearance) {
          recentlyLost.push(track);
        } else {
          finished.push(track);
        }
      }
    }

    // Expire recently-lost tracks whose gap has grown too large -- video
    // time, not frame count, since sampled frames aren't necessarily evenly
    // spaced.
    for (let i = recentlyLost.length - 1; i >= 0; i--) {
      if (frame.timestampSeconds - recentlyLost[i].lastTimestamp > RECENTLY_LOST_MAX_GAP_SECONDS) {
        finished.push(recentlyLost[i]);
        recentlyLost.splice(i, 1);
      }
    }

    // Try to resume a recently-lost track by appearance before spawning a
    // new identity for a still-unmatched detection -- position is too
    // stale to use here (that's why the track isn't in `live` anymore), so
    // this is appearance-only, greedy on distance, one lost-track per
    // detection.
    if (recentlyLost.length > 0) {
      for (let di = unmatchedDetections.length - 1; di >= 0; di--) {
        const det = unmatchedDetections[di];
        if (!det.appearanceSignature) continue;

        let bestIdx = -1;
        let bestDistance = Infinity;
        for (let ri = 0; ri < recentlyLost.length; ri++) {
          const candidate = recentlyLost[ri].appearance;
          if (!candidate) continue;
          const distance = appearanceDistance(candidate, det.appearanceSignature);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIdx = ri;
          }
        }

        if (bestIdx === -1 || bestDistance > APPEARANCE_MATCH_MAX_DISTANCE) continue;

        const revived = recentlyLost[bestIdx];
        recentlyLost.splice(bestIdx, 1);
        revived.points.push({
          timestampSeconds: frame.timestampSeconds,
          boxImageNorm: det.boxImageNorm,
          confidence: det.confidence,
          courtPosition: null,
        });
        revived.lastBox = det.boxImageNorm;
        revived.lastTimestamp = frame.timestampSeconds;
        revived.velocity = null; // stale gap -- don't extrapolate from before the loss
        revived.missedFrames = 0;
        revived.appearance = emaAppearance(revived.appearance, det.appearanceSignature);
        live.push(revived);
        unmatchedDetections.splice(di, 1);
      }
    }

    // Remaining unmatched detections start new tracks, capped at MAX_TRACKS
    // total across live + recently-lost (a recently-lost track is still a
    // real player who might come back, so it still counts against the cap
    // -- otherwise a brief occlusion could let a 5th "player" get fabricated).
    for (const det of unmatchedDetections) {
      if (live.length + recentlyLost.length >= MAX_TRACKS) break; // don't fabricate a 5th player
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
        appearance: det.appearanceSignature ?? null,
      });
    }
  }

  // Anything still sitting in recentlyLost never got revived by the end of
  // the clip -- it's finished.
  finished.push(...recentlyLost);

  const all = [...finished, ...live];
  // Drop tracks that only ever appeared once — almost certainly a false-positive
  // detection, not a real player, and would otherwise pollute player_N numbering.
  const real = all.filter((t) => t.points.length >= 2);

  return real.map((t) => ({ playerId: t.playerId, points: t.points }));
}
