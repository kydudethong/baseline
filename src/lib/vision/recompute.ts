import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  BallTrackRow,
  CourtCalibrationRow,
  Database,
  MovementMetricRow,
  PlayerTrackRow,
  VideoRow,
} from "@/lib/db/types";
import type { CourtCalibration, PlayerTrack, PlayerTrackPoint } from "./phase2-types";
import { analyzeMovement } from "./movement";
import { detectFootworkFoundation } from "./events";
import { buildBallTrack, detectBounces, detectHits, sliceTrack, type BallTrackPoint } from "./ball";
import { classifyRally, courtFrameFor, type Shot } from "./shots";
import { clusterRalliesFromHits, HIT_CLUSTER_PARAMS } from "./rallies";

type Client = SupabaseClient<Database>;

/** Fallback for when the stored video row has no duration_seconds (older
 * rows, or a probe that failed) — derives an upper bound from the latest
 * tracked timestamp and pads it slightly, same approach as facts.ts's
 * estimateDurationSeconds. */
function estimateDurationSeconds(tracks: PlayerTrack[]): number {
  let maxT = 0;
  for (const t of tracks) for (const p of t.points) maxT = Math.max(maxT, p.timestampSeconds);
  return maxT > 0 ? maxT + 5 : 0;
}

/**
 * Everything that depends on the court calibration — movement metrics and
 * shot classification — can be rebuilt from what's already stored
 * (player tracks, the ball track) without touching the video or any
 * model. That is what makes a manual calibration fix cheap: the user
 * drags four corners, this reruns in a second or two, and the numbers on
 * the page are right.
 *
 * Rally windows, hits and bounces are all recomputed the same way a fresh
 * pipeline run finds them — from the stored ball track alone (a hit is
 * the evidence a rally is live; player movement no longer decides
 * boundaries at all, see clusterRalliesFromHits in rallies.ts), no audio
 * — so a manual calibration fix can't leave an analysis with boundaries
 * or shots that disagree with what a rerun of the pipeline would
 * produce. Hits/bounces are recomputed fresh from the stored ball track
 * rather than reusing whatever unknown_shot events happen to be stored,
 * which is strictly more correct (source data, not a stale derivative of
 * it).
 */
export async function recomputeFromStored(supabase: Client, analysisId: string): Promise<{ shots: number; movement: number }> {
  const [calRes, tracksRes, ballRes, videoRes] = await Promise.all([
    supabase.from("court_calibrations").select("*").eq("analysis_id", analysisId).maybeSingle(),
    supabase.from("player_tracks").select("*").eq("analysis_id", analysisId),
    supabase.from("ball_tracks").select("*").eq("analysis_id", analysisId).maybeSingle(),
    supabase.from("videos").select("*").eq("analysis_id", analysisId).maybeSingle(),
  ]);
  for (const r of [calRes, tracksRes, ballRes, videoRes]) if (r.error) throw r.error;

  const calRow = calRes.data as CourtCalibrationRow | null;
  const video = videoRes.data as VideoRow | null;
  if (!calRow || !video?.width || !video?.height) return { shots: 0, movement: 0 };

  const calibration = calibrationFromRow(calRow);
  const width = video.width;
  const height = video.height;
  const tracks: PlayerTrack[] = ((tracksRes.data ?? []) as PlayerTrackRow[]).map((t) => ({
    playerId: t.player_label,
    points: (t.points as PlayerTrackPoint[] | null) ?? [],
  }));

  // movement_metrics
  let movementCount = 0;
  if (tracks.length > 0) {
    // `positioning` is deliberately absent from this shape, not set to null.
    // PostgREST's upsert only updates the columns present in the body, so
    // omitting it PRESERVES whatever the original run stored; writing null
    // would silently wipe a correct positioning summary. This path exists to
    // redo movement after the court corners are corrected, and it has neither
    // the partner set nor the return-of-serve times to rebuild positioning.
    type MovementRecomputeRow = Omit<MovementMetricRow, "id" | "created_at" | "positioning">;
    const rows: MovementRecomputeRow[] = tracks.map((t) => {
      const m = analyzeMovement(t, calibration, width, height);
      return {
        analysis_id: analysisId,
        player_label: m.playerId,
        distance_covered_court_units: m.distanceCoveredCourtUnits,
        distance_covered_meters_approx: m.distanceCoveredMetersApprox,
        average_speed_court_units_s: m.averageSpeedCourtUnitsPerSecond,
        max_speed_court_units_s: m.maxSpeedCourtUnitsPerSecond,
        court_coverage_bounds: m.courtCoverageBounds,
        transformed_sample_count: m.transformedSampleCount,
        total_sample_count: m.totalSampleCount,
        footwork: detectFootworkFoundation(t),
      };
    });
    const { error } = await supabase.from("movement_metrics").upsert(rows, { onConflict: "analysis_id,player_label" });
    if (error) throw error;
    movementCount = rows.length;
  }

  // analysis_shots
  const ball = ballRes.data as BallTrackRow | null;
  const shots: Shot[] = [];
  if (ball) {
    const points = (ball.points as BallTrackPoint[] | null) ?? [];
    // Points were stored post-tracking; rebuild nothing, just slice per rally.
    void buildBallTrack; // (kept importable for callers that store raw detections)
    const ctx = {
      calibration,
      frame: courtFrameFor(calibration.quadKind),
      frameWidthPx: width,
      frameHeightPx: height,
      playerTracks: tracks,
    };
    const durationSeconds = video.duration_seconds ?? estimateDurationSeconds(tracks);
    // Rally boundaries come from ball hits, not player motion (see
    // clusterRalliesFromHits, rallies.ts) -- cheap to redo here since the
    // whole stored ball track is already in memory, no new detector call.
    const allHitsWide = detectHits(points, tracks);
    const rallies = clusterRalliesFromHits(allHitsWide.map((h) => h.t), durationSeconds, HIT_CLUSTER_PARAMS);
    for (const r of rallies) {
      const pts = sliceTrack(points, r.startS - 0.3, r.endS + 0.3);
      const hits = detectHits(pts, tracks);
      const bounces = detectBounces(pts, hits.map((h) => h.t));
      shots.push(...classifyRally({ rallyIdx: r.idx, startS: r.startS, endS: r.endS, hits, bounces, ballPoints: pts }, ctx));
    }
  }
  {
    const { error: del } = await supabase.from("analysis_shots").delete().eq("analysis_id", analysisId);
    if (del) throw del;
    if (shots.length > 0) {
      const { error } = await supabase.from("analysis_shots").insert(
        shots.map((s) => ({
          analysis_id: analysisId,
          rally_idx: s.rallyIdx,
          shot_idx: s.shotIdx,
          timestamp_s: s.t,
          player_label: s.playerId,
          shot_type: s.type,
          category: s.category,
          confidence: s.confidence,
          hit_court: s.hitCourt,
          hit_zone: s.hitZone,
          landing_court: s.landingCourt,
          landing_zone: s.landingZone,
          speed_mps_approx: s.speedMpsApprox,
          arc_norm: s.arcNorm,
          bounced_before: s.bouncedBefore,
          outcome: s.outcome,
          features: s.features,
        }))
      );
      if (error) throw error;
    }
  }
  return { shots: shots.length, movement: movementCount };
}

export function calibrationFromRow(row: CourtCalibrationRow): CourtCalibration {
  const diag = (row.diagnostics as Record<string, unknown> | null) ?? {};
  const kind = diag.quadKind;
  return {
    method: row.method as CourtCalibration["method"],
    confidence: Number(row.confidence),
    cornersImagePx: (row.corners_image_px as CourtCalibration["cornersImagePx"]) ?? null,
    quadKind: kind === "near-inplay" || kind === "near-half" || kind === "full" ? kind : null,
    frameTimestampSeconds: Number(row.frame_timestamp_s),
    diagnostics: diag,
  };
}
