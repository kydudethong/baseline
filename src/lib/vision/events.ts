import { detectAudioEventsViaPython } from "./cv-scripts";
import type { AnalysisEvent, FootworkFoundationMetrics, PlayerTrack } from "./phase2-types";

/**
 * unknown_shot events: WHEN a paddle contact likely happened, from audio —
 * never WHAT shot it was. Per spec, shot-type classification is explicitly
 * out of scope for this phase; asserting "dink" or "drive" without a model
 * that actually distinguishes them would be exactly the kind of fabricated
 * confidence this project is built to avoid.
 */
export async function detectUnknownShotEvents(videoPath: string): Promise<{
  events: AnalysisEvent[];
  diagnostics: Record<string, unknown>;
}> {
  const raw = await detectAudioEventsViaPython(videoPath);
  const events: AnalysisEvent[] = raw.events.map((e) => ({
    type: "unknown_shot",
    timestampSeconds: e.timestampSeconds,
    playerId: null, // audio has no spatial info — which player contacted is not claimed
    // Strength is a relative onset measure, not a calibrated probability;
    // squash it into a defensible 0-1 confidence band rather than passing
    // an unbounded number through as if it meant something absolute.
    confidence: Math.max(0.3, Math.min(0.95, e.strength * 4)),
    source: "audio-onset",
  }));
  return { events, diagnostics: raw.diagnostics };
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
  for (let i = 1; i < boxHeightSeries.length - 1; i++) {
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
