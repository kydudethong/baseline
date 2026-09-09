import type { AnalysisEvent, FootworkFoundationMetrics, PlayerTrack } from "./phase2-types";
import type { BallHit } from "./ball";

/**
 * unknown_shot events: WHEN a paddle contact likely happened, from the
 * ball's own tracked trajectory (see ball.ts's detectHits) — never WHAT
 * shot it was. Per spec, shot-type classification is explicitly out of
 * scope for this phase; asserting "dink" or "drive" without a model that
 * actually distinguishes them would be exactly the kind of fabricated
 * confidence this project is built to avoid.
 *
 * This used to be its own audio-analysis step run once up front, before
 * ball detection. Now that hits come from the ball track, they're a
 * byproduct of ball detection (computed per-rally in run-vision-pipeline.ts
 * and recompute.ts) rather than a separate pass — this is just the shared
 * mapping from a BallHit to the AnalysisEvent shape the rest of the app
 * (facts.ts, coaching prompts, the DB) already expects.
 */
export function hitsToUnknownShotEvents(hits: BallHit[]): AnalysisEvent[] {
  return hits.map((h) => ({
    type: "unknown_shot",
    timestampSeconds: h.t,
    playerId: h.playerId,
    confidence: h.confidence,
    source: "movement-heuristic",
  }));
}

const SPLIT_STEP_MIN_DROP = 0.03; // normalized bbox-height drop that counts as a "crouch" candidate
const SPLIT_STEP_MIN_CONFIDENCE = 0.3;

/**
 * possible_split_step: a CANDIDATE event only (per spec — "no technique
 * judgments", "measurable extraction"). Looks for a local dip in a
 * player's bounding-box height (a crude proxy for crouching) around a
 * change in lateral position. This is explicitly a heuristic on a noisy
 * signal (bbox height also drops from imperfect detection, partial
 * occlusion, and camera-angle foreshortening) — confidence is capped well
 * below "certain", and nothing downstream should treat this as verified
 * footwork technique.
 */
export function detectFootworkFoundation(track: PlayerTrack): FootworkFoundationMetrics {
  const boxHeightSeries = track.points.map((p) => ({
    timestampSeconds: p.timestampSeconds,
    heightNorm: p.boxImageNorm.height,
  }));

  const xs = track.points.map((p) => p.boxImageNorm.x + p.boxImageNorm.width / 2);
  const lateralRangeCourtUnits = xs.length > 0 ? Math.max(...xs) - Math.min(...xs) : null;

  const possibleSplitSteps: FootworkFoundationMetrics["possibleSplitSteps"] = [];
  // Track points are not contiguous in time -- the tracker revives an identity
  // across gaps of several seconds, and the revived box is usually a very
  // different size because the player crossed the court. Comparing i-1/i/i+1
  // by index turns that size change into a "crouch" and timestamps a
  // split-step at the moment of revival.
  const MAX_TRIPLE_SPAN_S = 0.5;
  for (let i = 1; i < boxHeightSeries.length - 1; i++) {
    const span = boxHeightSeries[i + 1].timestampSeconds - boxHeightSeries[i - 1].timestampSeconds;
    if (!(span > 0) || span > MAX_TRIPLE_SPAN_S) continue;
    const prev = boxHeightSeries[i - 1].heightNorm;
    const cur = boxHeightSeries[i].heightNorm;
    const next = boxHeightSeries[i + 1].heightNorm;
    const dip = Math.min(prev, next) - cur;
    if (dip >= SPLIT_STEP_MIN_DROP) {
      const confidence = Math.min(0.75, SPLIT_STEP_MIN_CONFIDENCE + dip * 5);
      possibleSplitSteps.push({
        timestampSeconds: boxHeightSeries[i].timestampSeconds,
        confidence: Math.round(confidence * 100) / 100,
      });
    }
  }

  return {
    playerId: track.playerId,
    lateralRangeCourtUnits,
    boxHeightSeries,
    possibleSplitSteps,
  };
}
