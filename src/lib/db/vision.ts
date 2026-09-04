import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AnalysisEventRow,
  AnalysisFrameRow,
  AnalysisShotRow,
  BallTrackRow,
  CourtCalibrationRow,
  Database,
  MovementMetricRow,
  PlayerKeypointRow,
  PlayerTrackRow,
} from "./types";

type Client = SupabaseClient<Database>;

export interface Phase2Data {
  calibration: CourtCalibrationRow | null;
  frames: AnalysisFrameRow[];
  tracks: PlayerTrackRow[];
  keypoints: PlayerKeypointRow[];
  movement: MovementMetricRow[];
  events: AnalysisEventRow[];
  shots: AnalysisShotRow[];
  ballTrack: BallTrackRow | null;
}

/** Everything the debug page and the analysis page's movement section need, in one round trip per table. */
export async function getPhase2Data(supabase: Client, analysisId: string): Promise<Phase2Data> {
  const [calibrationRes, framesRes, tracksRes, keypointsRes, movementRes, eventsRes, shotsRes, ballRes] = await Promise.all([
    supabase.from("court_calibrations").select("*").eq("analysis_id", analysisId).maybeSingle(),
    supabase.from("analysis_frames").select("*").eq("analysis_id", analysisId).order("frame_index"),
    supabase.from("player_tracks").select("*").eq("analysis_id", analysisId).order("player_label"),
    supabase.from("player_keypoints").select("*").eq("analysis_id", analysisId).order("timestamp_s"),
    supabase.from("movement_metrics").select("*").eq("analysis_id", analysisId).order("player_label"),
    supabase.from("analysis_events").select("*").eq("analysis_id", analysisId).order("timestamp_s"),
    supabase.from("analysis_shots").select("*").eq("analysis_id", analysisId).order("timestamp_s"),
    supabase.from("ball_tracks").select("*").eq("analysis_id", analysisId).maybeSingle(),
  ]);

  return {
    calibration: (calibrationRes.data as CourtCalibrationRow | null) ?? null,
    frames: (framesRes.data as AnalysisFrameRow[] | null) ?? [],
    tracks: (tracksRes.data as PlayerTrackRow[] | null) ?? [],
    keypoints: (keypointsRes.data as PlayerKeypointRow[] | null) ?? [],
    movement: (movementRes.data as MovementMetricRow[] | null) ?? [],
    events: (eventsRes.data as AnalysisEventRow[] | null) ?? [],
    shots: (shotsRes.data as AnalysisShotRow[] | null) ?? [],
    ballTrack: (ballRes.data as BallTrackRow | null) ?? null,
  };
}
