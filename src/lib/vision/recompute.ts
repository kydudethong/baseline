import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AnalysisEventRow,
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
import { clusterRalliesWithContacts } from "./rallies";

type Client = SupabaseClient<Database>;

/**
 * Everything that depends on the court calibration — movement metrics and
 * shot classification — can be rebuilt from what's already stored
 * (player tracks, the ball track, audio contacts) without touching the
 * video or any model. That is what makes a manual calibration fix cheap:
 * the user drags four corners, this reruns in a second or two, and the
 * numbers on the page are right.
 */
export async function recomputeFromStored(supabase: Client, analysisId: string): Promise<{ shots: number; movement: number }> {
  const [calRes, tracksRes, ballRes, eventsRes, videoRes] = await Promise.all([
    supabase.from("court_calibrations").select("*").eq("analysis_id", analysisId).maybeSingle(),
    supabase.from("player_tracks").select("*").eq("analysis_id", analysisId),
    supabase.from("ball_tracks").select("*").eq("analysis_id", analysisId).maybeSingle(),
    supabase.from("analysis_events").select("*").eq("analysis_id", analysisId).eq("event_type", "unknown_shot"),
    supabase.from("videos").select("*").eq("analysis_id", analysisId).maybeSingle(),
  ]);
  for (const r of [calRes, tracksRes, ballRes, eventsRes, videoRes]) if (r.error) throw r.error;

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
    const rows: Omit<MovementMetricRow, "id" | "created_at">[] = tracks.map((t) => {
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
  const contacts = ((eventsRes.data ?? []) as AnalysisEventRow[]).map((e) => Number(e.timestamp_s)).sort((a, b) => a - b);
  const shots: Shot[] = [];
  if (ball && contacts.length > 0) {
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
    for (const r of clusterRalliesWithContacts(contacts)) {
      const pts = sliceTrack(points, r.startS - 0.3, r.endS + 0.3);
      const hits = detectHits(pts, r.contacts, tracks);
      const bounces = detectBounces(pts, r.contacts);
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
