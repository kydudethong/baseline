/**
 * Time to the kitchen after a return of serve — the half of that metric the
 * vision pipeline cannot compute.
 *
 * WHY IT IS SPLIT ACROSS TWO PLACES. The measurement is "how long, from this
 * moment, until the player reaches the kitchen line". The measuring is pure
 * geometry over court positions and lives in positioning.ts. But the MOMENT is
 * the return of serve, and nothing in the vision pipeline knows when a return
 * happened -- shot types are the model's judgement now. The vision run
 * therefore stores everything it can and leaves three fields null; this fills
 * them in once the model has said which shots were returns.
 *
 * Patching rather than rewriting the positioning blob: the vision run's
 * numbers are correct and this has nothing to add to them. Overwriting the
 * whole object from here would mean re-deriving zone fractions from a second
 * source, which is how two numbers that should agree stop agreeing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, MovementMetricRow, PlayerTrackRow, CourtCalibrationRow } from "@/lib/db/types";
import { analyzeMovement } from "@/lib/vision/movement";
import { courtFrameFor } from "@/lib/vision/shots";
import { timeToKitchenAfter, type PlayerPositioning } from "@/lib/vision/positioning";
import type { CourtCalibration } from "@/lib/vision/phase2-types";

type Client = SupabaseClient<Database>;

/**
 * Fill in secondsToKitchenMedian and the approach counts for every player.
 *
 * Returns how many rows it updated. Never throws: this is an enrichment of a
 * record that is already correct and useful without it, and failing a coaching
 * run over it would be a bad trade.
 */
export async function fillApproachTimes(
  supabase: Client,
  analysisId: string,
  returnTimes: number[],
  frameWidthPx: number,
  frameHeightPx: number,
  onLog?: (line: string) => void
): Promise<number> {
  if (returnTimes.length === 0) {
    onLog?.("approach times: no returns of serve were identified, so nothing to measure from");
    return 0;
  }

  try {
    const [movementRes, tracksRes, calRes] = await Promise.all([
      supabase.from("movement_metrics").select("*").eq("analysis_id", analysisId),
      supabase.from("player_tracks").select("*").eq("analysis_id", analysisId),
      supabase.from("court_calibrations").select("*").eq("analysis_id", analysisId).maybeSingle(),
    ]);
    const movement = (movementRes.data ?? []) as MovementMetricRow[];
    const tracks = (tracksRes.data ?? []) as PlayerTrackRow[];
    const cal = (calRes.data as CourtCalibrationRow | null) ?? null;
    if (movement.length === 0 || tracks.length === 0 || !cal) return 0;

    const calibration = {
      method: cal.method,
      confidence: Number(cal.confidence),
      cornersImagePx: cal.corners_image_px,
      frameTimestampSeconds: Number(cal.frame_timestamp_s),
      diagnostics: cal.diagnostics,
      quadKind: (cal.diagnostics as { quadKind?: string } | null)?.quadKind ?? null,
    } as unknown as CourtCalibration;
    const frame = courtFrameFor(calibration.quadKind);

    let updated = 0;
    for (const row of movement) {
      const existing = row.positioning as PlayerPositioning | null;
      if (!existing || typeof existing !== "object") continue;
      const track = tracks.find((t) => t.player_label === row.player_label);
      if (!track) continue;

      const m = analyzeMovement(
        { playerId: track.player_label, points: (track.points as never) ?? [] },
        calibration, frameWidthPx, frameHeightPx
      );
      const samples = m.samples.map((s) => ({
        timestampSeconds: s.timestampSeconds, courtX: s.courtX, courtY: s.courtY,
      }));
      if (samples.length === 0) continue;

      const approach = timeToKitchenAfter(samples, returnTimes, frame);
      const { error } = await supabase
        .from("movement_metrics")
        .update({
          positioning: {
            ...existing,
            secondsToKitchenMedian: approach.medianSeconds,
            approachesMeasured: approach.secondsToKitchen.length,
            approachesNeverArrived: approach.neverArrived,
          },
        })
        .eq("id", row.id);
      if (error) throw error;
      updated++;
      onLog?.(
        `approach ${row.player_label}: median ${approach.medianSeconds ?? "—"}s to the kitchen `
        + `across ${approach.secondsToKitchen.length} return(s)`
        + (approach.neverArrived ? `, ${approach.neverArrived} never got there` : "")
      );
    }
    return updated;
  } catch (err) {
    onLog?.(`approach times skipped: ${(err as Error).message.split("\n")[0]}`);
    return 0;
  }
}
