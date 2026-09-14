/**
 * Hand-written types mirroring `supabase/migrations/0001_init.sql`.
 *
 * Once the project is linked to a real Supabase instance, replace this file
 * by running:
 *
 *   npx supabase gen types typescript --project-id <id> > src/lib/db/types.ts
 *
 * and re-export the app-level aliases below from the generated file so the
 * rest of the codebase doesn't need to change.
 *
 * IMPORTANT: every Row/Insert/Update/Database shape below is declared with
 * `type`, never `interface`. @supabase/postgrest-js's insert/update type
 * inference depends on these being plain object types — an `interface` (even
 * with an identical shape) doesn't satisfy its internal `Record<string,
 * unknown>` checks the same way, and silently collapses `.insert()`/
 * `.update()` argument types to `never`. Cost real time to track down, so:
 * `type`, not `interface`, for anything that ends up in `Database`.
 */

import type { AnalysisResult } from "@/lib/analysis/types";

export type AnalysisStatus =
  | "uploaded"
  | "queued"
  | "processing"
  | "completed"
  | "failed";

export const ANALYSIS_STATUSES: AnalysisStatus[] = [
  "uploaded",
  "queued",
  "processing",
  "completed",
  "failed",
];

/** Structured output of an AnalysisEngine run. Canonical definition lives in
 *  src/lib/analysis/types.ts; re-exported here so DB row types can reference
 *  it without the db layer depending on the analysis layer's other exports. */
export type { AnalysisResult };

export type ProfileRow = {
  id: string;
  display_name: string | null;
  // Coaching-layer fields — mirrors 0005_coaching_layer.sql, ported from
  // coach's singleton `player` row (skill self-report, paddle hand).
  skill_level: string | null;
  paddle_hand: string | null; // 'left' | 'right'
  created_at: string;
  updated_at: string;
};
export type ProfileInsert = {
  id: string;
  display_name?: string | null;
  skill_level?: string | null;
  paddle_hand?: string | null;
  created_at?: string;
  updated_at?: string;
};
export type ProfileUpdate = {
  id?: string;
  display_name?: string | null;
  skill_level?: string | null;
  paddle_hand?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type AnalysisRow = {
  id: string;
  user_id: string;
  title: string;
  status: AnalysisStatus;
  error_message: string | null;
  result: AnalysisResult | null;
  // Coaching-layer fields — mirrors 0005_coaching_layer.sql.
  self_player_label: string | null;
  pre_analysis_setup: unknown | null;
  coaching_notes: string | null;
  coaching_kind: string;
  // Frontend data model — 0009_frontend_data_model.sql.
  // Live stage of a run in flight. Deliberately has no percentage: the pipeline
  // does not know how far through it is, and inventing one would be the exact
  // dishonesty this product is built against.
  progress: AnalysisProgress | null;
  // A storage KEY, never a URL and never a local path, so the debug renderer
  // can move from public/rally-debug to object storage without the frontend
  // changing.
  debug_video_path: string | null;
  debug_video_bucket: string | null;
  /** Stamped on entry to 'processing'. Null for runs from before migration 0010. */
  started_at: string | null;
  /** Stamped on 'completed' or 'failed'. Null while running. */
  finished_at: string | null;
  /** Touched every ~15s by the live run. Quiet on a 'processing' row = dead, not busy. */
  heartbeat_at: string | null;
  /**
   * Set when the player archives this analysis — 0016. Archived rows are
   * hidden from the library, the calendar and trends but keep every dependent
   * row, so un-archiving is an update rather than a re-upload. Permanent
   * deletion is a separate operation that removes the row and cascades.
   */
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

// --- Practice calendar — 0016_archive_and_calendar.sql ----------------------

export type PracticePlanRow = {
  id: string;
  user_id: string;
  /** First day of the month this plan covers. */
  month: string;
  sessions_per_month: number | null;
  /** 0 = Sunday .. 6 = Saturday. */
  play_days: number[];
  focus: string | null;
  targets: string[];
  source_analysis_ids: string[];
  created_at: string;
  updated_at: string;
};
export type PracticePlanInsert = Omit<PracticePlanRow, "id" | "created_at" | "updated_at">
  & { id?: string; created_at?: string; updated_at?: string };

export type PracticeSessionRow = {
  id: string;
  plan_id: string;
  scheduled_on: string;
  kind: "practice" | "match" | "rest" | "assessment";
  title: string;
  focus: string | null;
  minutes: number | null;
  completed_at: string | null;
  notes: string | null;
  created_at: string;
};
export type PracticeSessionInsert = Omit<PracticeSessionRow, "id" | "created_at">
  & { id?: string; created_at?: string };

export type PracticeSessionDrillRow = {
  id: string;
  session_id: string;
  idx: number;
  drill_slug: string | null;
  name: string;
  minutes: number | null;
  how: string | null;
  success: string | null;
  targets: string | null;
  completed_at: string | null;
  created_at: string;
};
export type PracticeSessionDrillInsert = Omit<PracticeSessionDrillRow, "id" | "created_at">
  & { id?: string; created_at?: string };

/** Stages in pipeline order. A UI shows these as done / running / not yet. */
export type AnalysisStage =
  | "preparing"
  | "court"
  | "players"
  | "pose"
  | "ball"
  | "contacts"
  | "rallies"
  | "shots"
  | "mechanics"
  | "saving"
  | "coaching"
  | "overlay";

export const ANALYSIS_STAGES: AnalysisStage[] = [
  "preparing", "court", "players", "pose", "ball", "contacts",
  "rallies", "shots", "mechanics", "saving", "coaching", "overlay",
];

export const ANALYSIS_STAGE_LABELS: Record<AnalysisStage, string> = {
  preparing: "Preparing the video",
  court: "Finding the court",
  players: "Finding the players",
  pose: "Reading body position",
  ball: "Tracking the ball",
  contacts: "Finding paddle contacts",
  rallies: "Working out the rallies",
  shots: "Classifying shots",
  mechanics: "Measuring your swing",
  saving: "Saving results",
  coaching: "Writing your coaching read",
  overlay: "Rendering the tracking overlay",
};

export type AnalysisProgress = {
  stage: AnalysisStage;
  /** The pipeline's own words for what it is doing right now. */
  message: string;
  /** Stages already finished, so a UI can tick them off. */
  completedStages: AnalysisStage[];
  updatedAt: string;
};
export type AnalysisInsert = {
  id?: string;
  user_id: string;
  title: string;
  status?: AnalysisStatus;
  error_message?: string | null;
  result?: AnalysisResult | null;
  self_player_label?: string | null;
  pre_analysis_setup?: unknown | null;
  coaching_notes?: string | null;
  coaching_kind?: string;
  progress?: AnalysisProgress | null;
  debug_video_path?: string | null;
  debug_video_bucket?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  heartbeat_at?: string | null;
  /** 0016. Null restores; a timestamp archives. */
  archived_at?: string | null;
  created_at?: string;
  updated_at?: string;
};
export type AnalysisUpdate = {
  id?: string;
  user_id?: string;
  title?: string;
  status?: AnalysisStatus;
  error_message?: string | null;
  result?: AnalysisResult | null;
  self_player_label?: string | null;
  pre_analysis_setup?: unknown | null;
  coaching_notes?: string | null;
  coaching_kind?: string;
  progress?: AnalysisProgress | null;
  debug_video_path?: string | null;
  debug_video_bucket?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  heartbeat_at?: string | null;
  /** 0016. Null restores; a timestamp archives. */
  archived_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type VideoRow = {
  id: string;
  analysis_id: string;
  user_id: string;
  storage_bucket: string;
  storage_path: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  probe_metadata: Record<string, unknown> | null;
  created_at: string;
};
export type VideoInsert = {
  id?: string;
  analysis_id: string;
  user_id: string;
  storage_bucket?: string;
  storage_path: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  duration_seconds?: number | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  codec?: string | null;
  probe_metadata?: Record<string, unknown> | null;
  created_at?: string;
};
export type VideoUpdate = {
  id?: string;
  analysis_id?: string;
  user_id?: string;
  storage_bucket?: string;
  storage_path?: string;
  original_filename?: string;
  mime_type?: string;
  size_bytes?: number;
  duration_seconds?: number | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  codec?: string | null;
  probe_metadata?: Record<string, unknown> | null;
  created_at?: string;
};

// ---------------------------------------------------------------------------
// Phase 2 vision-pipeline tables — mirrors supabase/migrations/0003_phase2_vision.sql.
// jsonb columns are typed `unknown` here rather than importing the vision
// layer's rich types, deliberately: the db layer shouldn't depend on the
// CV layer's internal shapes just to describe a jsonb column, and callers
// (pipeline-v2.ts) already have the precisely-typed values before they're
// serialized into these rows.
// ---------------------------------------------------------------------------

export type CourtCalibrationRow = {
  id: string;
  analysis_id: string;
  method: string;
  confidence: number;
  corners_image_px: unknown;
  frame_timestamp_s: number;
  diagnostics: unknown;
  created_at: string;
};
export type CourtCalibrationInsert = Omit<CourtCalibrationRow, "id" | "created_at"> & {
  id?: string;
  created_at?: string;
};
export type CourtCalibrationUpdate = Partial<CourtCalibrationInsert>;

export type AnalysisFrameRow = {
  id: string;
  analysis_id: string;
  timestamp_s: number;
  frame_index: number;
  player_count: number;
  debug_storage_path: string | null;
  created_at: string;
};
export type AnalysisFrameInsert = Omit<AnalysisFrameRow, "id" | "created_at"> & {
  id?: string;
  created_at?: string;
};
export type AnalysisFrameUpdate = Partial<AnalysisFrameInsert>;

export type PlayerTrackRow = {
  id: string;
  analysis_id: string;
  player_label: string;
  first_seen_s: number;
  last_seen_s: number;
  point_count: number;
  points: unknown;
  created_at: string;
};
export type PlayerTrackInsert = Omit<PlayerTrackRow, "id" | "created_at"> & {
  id?: string;
  created_at?: string;
};
export type PlayerTrackUpdate = Partial<PlayerTrackInsert>;

export type PlayerKeypointRow = {
  id: string;
  analysis_id: string;
  player_label: string;
  timestamp_s: number;
  detection_confidence: number | null;
  keypoints: unknown;
  model_source: string;
  created_at: string;
};
export type PlayerKeypointInsert = Omit<PlayerKeypointRow, "id" | "created_at"> & {
  id?: string;
  created_at?: string;
};
export type PlayerKeypointUpdate = Partial<PlayerKeypointInsert>;

export type MovementMetricRow = {
  id: string;
  analysis_id: string;
  player_label: string;
  distance_covered_court_units: number | null;
  distance_covered_meters_approx: number | null;
  average_speed_court_units_s: number | null;
  max_speed_court_units_s: number | null;
  court_coverage_bounds: unknown;
  transformed_sample_count: number;
  total_sample_count: number;
  footwork: unknown;
  created_at: string;
};
export type MovementMetricInsert = Omit<MovementMetricRow, "id" | "created_at"> & {
  id?: string;
  created_at?: string;
};
export type MovementMetricUpdate = Partial<MovementMetricInsert>;

export type AnalysisEventRow = {
  id: string;
  analysis_id: string;
  event_type: "unknown_shot" | "possible_split_step";
  timestamp_s: number;
  player_label: string | null;
  confidence: number;
  source: "movement-heuristic" | "mock";
  created_at: string;
};
export type BallTrackRow = {
  id: string;
  analysis_id: string;
  /** [{t,x,y,conf,interpolated}] in image-normalized coordinates — see src/lib/vision/ball.ts. */
  points: unknown;
  frames_processed: number;
  points_detected: number;
  points_interpolated: number;
  coverage: number;
  diagnostics: unknown;
  created_at: string;
};
export type BallTrackInsert = Omit<BallTrackRow, "id" | "created_at"> & { id?: string; created_at?: string };
export type BallTrackUpdate = Partial<BallTrackInsert>;

/* ------------------------------------------------------------------------ */
/* Frontend data model — 0009_frontend_data_model.sql                       */
/* ------------------------------------------------------------------------ */

/**
 * The SEGMENTER's rallies, not the coaching pass's re-derivation.
 *
 * Written in the same persist as analysis_shots, from the same rallies array
 * the shots were cut from — so analysis_shots.rally_idx IS a valid join key
 * against this table. It remains unsafe against coaching_rallies, which
 * re-clusters contact timestamps later and disagrees on numbering and count.
 */
export type AnalysisRallyRow = {
  id: string;
  analysis_id: string;
  idx: number;
  start_s: number;
  end_s: number;
  /** Which segmenter drew this boundary — a UI should say so. */
  source: "net-crossings" | "hit-clustering" | "contacts" | "rally_seg" | "unknown";
  /** Why it ended, where the segmenter knows. Null is honest. */
  end_reason: string | null;
  contact_count: number;
  crossing_count: number | null;
  /** Seconds keep-alive added past the last crossing. 0 = ended on its own. */
  extended_seconds: number;
  contacts: RallyContact[] | null;
  /** Null until the coaching pass runs. Shown as "no verdict", never neutral. */
  verdict: "won" | "lost" | "unforced_error" | "neutral" | "unknown" | null;
  verdict_reason: string | null;
  verdict_confidence: number | null;
  created_at: string;
};

export type RallyContact = {
  t_s: number;
  side: "self" | "opponent" | "unknown";
  confidence: number;
};

export type AnalysisRallyInsert =
  Omit<AnalysisRallyRow, "id" | "created_at" | "verdict" | "verdict_reason" | "verdict_confidence">
  & {
    id?: string;
    created_at?: string;
    verdict?: AnalysisRallyRow["verdict"];
    verdict_reason?: string | null;
    verdict_confidence?: number | null;
  };
export type AnalysisRallyUpdate = Partial<AnalysisRallyInsert>;

/**
 * What the pipeline knows about its own reliability.
 *
 * Every field is nullable because every one of them can genuinely fail to be
 * measured. A UI reads this to decide how confidently to present anything else.
 */
export type AnalysisQualityRow = {
  analysis_id: string;
  vision_fps: number | null;
  video_duration_s: number | null;
  frames_sampled: number | null;
  players_per_frame: { min: number; max: number; mean: number } | null;
  tracks_produced: number | null;
  tracks_with_stable_id: number | null;
  pose_frames_attempted: number | null;
  pose_frames_succeeded: number | null;
  ball_coverage: number | null;
  ball_frames_processed: number | null;
  ball_points_detected: number | null;
  ball_points_interpolated: number | null;
  court_confidence: number | null;
  court_method: string | null;
  contacts_found: number | null;
  shots_classified: number | null;
  /** Balls that crossed once and never came back — a serve into the net. */
  dead_ball_count: number | null;
  rally_source: string | null;
  limitations: string[] | null;
  created_at: string;
};

export type AnalysisQualityInsert =
  Omit<AnalysisQualityRow, "created_at"> & { created_at?: string };
export type AnalysisQualityUpdate = Partial<AnalysisQualityInsert>;

export type AnalysisShotRow = {
  id: string;
  analysis_id: string;
  rally_idx: number;
  shot_idx: number;
  timestamp_s: number;
  player_label: string | null;
  shot_type: string;
  category: string;
  confidence: number;
  hit_court: unknown;
  hit_zone: string;
  landing_court: unknown;
  landing_zone: string;
  speed_mps_approx: number | null;
  arc_norm: number | null;
  bounced_before: boolean | null;
  outcome: string;
  features: unknown;
  /**
   * Swing mechanics for this contact, or null when they could not be measured.
   *
   * NULL MEANS ABSENT, NOT ZERO. A knee angle of 0 is a claim; absence is not.
   * Anything reading this must keep the distinction all the way to the screen.
   */
  mechanics: ShotMechanicsRow | null;
  created_at: string;
};

/**
 * Body-relative, never pixels: shoulder widths and torsos, so a shot at the far
 * baseline is comparable with one at the near baseline. Every field is
 * independently nullable — a measurement that could not be made is null on its
 * own, not the whole object.
 */
export type ShotMechanicsRow = {
  pose_samples: number;
  hitting_hand: "left" | "right" | "unknown";
  knee_angle_at_contact_deg: number | null;
  knee_angle_min_deg: number | null;
  contact_height_torsos: number | null;
  contact_reach_shoulders: number | null;
  backswing_shoulders: number | null;
  wrist_speed_into_contact: number | null;
  follow_through_shoulders: number | null;
  shoulder_rotation_deg: number | null;
  confidence: number;
};
export type AnalysisShotInsert =
  Omit<AnalysisShotRow, "id" | "created_at" | "mechanics">
  & { id?: string; created_at?: string; mechanics?: ShotMechanicsRow | null };
export type AnalysisShotUpdate = Partial<AnalysisShotInsert>;

export type AnalysisEventInsert = Omit<AnalysisEventRow, "id" | "created_at"> & {
  id?: string;
  created_at?: string;
};
export type AnalysisEventUpdate = Partial<AnalysisEventInsert>;

// ---------------------------------------------------------------------------
// Coaching-layer tables — mirrors supabase/migrations/0005_coaching_layer.sql.
// Ported from coach's ("Baseline") SQLite schema onto Rally IQ's CV facts;
// see that migration's header comment for the honesty constraints these
// tables exist under (heuristics, never fabricated measurements).
// ---------------------------------------------------------------------------

export type CoachingRallyRow = {
  id: string;
  analysis_id: string;
  idx: number;
  start_s: number;
  end_s: number;
  shots: number;
};
export type CoachingRallyInsert = Omit<CoachingRallyRow, "id"> & { id?: string };
export type CoachingRallyUpdate = Partial<CoachingRallyInsert>;

export type CoachingReadRow = {
  id: string;
  analysis_id: string;
  model: string | null;
  headline: string | null;
  summary: string | null;
  quality: unknown;
  coaching_json: string | null;
  facts_json: string | null;
  created_at: string;
};
export type CoachingReadInsert = Omit<CoachingReadRow, "id" | "created_at"> & {
  id?: string;
  created_at?: string;
};
export type CoachingReadUpdate = Partial<CoachingReadInsert>;

export type CoachingObservationRow = {
  id: string;
  analysis_id: string;
  read_id: string;
  rally_idx: number | null;
  t_s: number | null;
  skill_key: string;
  coaching_dimension: string;
  valence: "strength" | "weakness";
  title: string;
  detail: string;
  severity: number;
  dismissed: boolean;
  /**
   * The coaching hierarchy: what happened (title/detail) -> why it matters ->
   * what to change -> how to practise it.
   *
   * All nullable. Until 0009 this shape existed for exactly one thing per
   * analysis (CoachingRead.top_priority_fix); every other observation carried
   * title and detail only. An observation the model could not justify keeps
   * these null, and the UI shows the halves that exist rather than an empty
   * template.
   */
  why_it_matters: string | null;
  what_to_change: string | null;
  drill_slug: string | null;
  /** Position in the rally, when the observation is about one specific shot. */
  shot_idx: number | null;
};
export type CoachingObservationInsert =
  Omit<CoachingObservationRow, "id" | "dismissed"
       | "why_it_matters" | "what_to_change" | "drill_slug" | "shot_idx">
  & {
    id?: string;
    dismissed?: boolean;
    // Optional on insert: an observation without them is written without the
    // keys, so a missing justification stays missing rather than becoming "".
    why_it_matters?: string | null;
    what_to_change?: string | null;
    drill_slug?: string | null;
    shot_idx?: number | null;
  };
export type CoachingObservationUpdate = Partial<CoachingObservationInsert>;

export type CoachingSkillRatingRow = {
  id: string;
  analysis_id: string;
  skill_key: string;
  raw: number;
  observations: number;
  basis: string | null;
};
export type CoachingSkillRatingInsert = Omit<CoachingSkillRatingRow, "id"> & { id?: string };
export type CoachingSkillRatingUpdate = Partial<CoachingSkillRatingInsert>;

/** Shared reference content (the drill library) — keyed by slug, not id. */
export type CoachingDrillRow = {
  slug: string;
  name: string;
  skill_key: string;
  difficulty: string;
  players: number;
  equipment: string;
  purpose: string;
  steps: unknown;
  mistakes: unknown;
  progression: string | null;
  regression: string | null;
};
export type CoachingDrillInsert = CoachingDrillRow;
export type CoachingDrillUpdate = Partial<CoachingDrillRow>;

export type CoachingBlueprintRow = {
  id: string;
  user_id: string;
  analysis_id: string | null;
  skill_key: string;
  title: string;
  goal: string;
  target: string;
  status: string;
  created_at: string;
};
export type CoachingBlueprintInsert = Omit<CoachingBlueprintRow, "id" | "created_at"> & {
  id?: string;
  created_at?: string;
};
export type CoachingBlueprintUpdate = Partial<CoachingBlueprintInsert>;

export type CoachingBlueprintStepRow = {
  id: string;
  blueprint_id: string;
  idx: number;
  focus: string;
  drill_slug: string | null;
  drill_name: string;
  target: string;
  done_at: string | null;
};
export type CoachingBlueprintStepInsert = Omit<CoachingBlueprintStepRow, "id"> & { id?: string };
export type CoachingBlueprintStepUpdate = Partial<CoachingBlueprintStepInsert>;

export type CoachingChatMessageRow = {
  id: string;
  user_id: string;
  role: "user" | "coach";
  content: string;
  created_at: string;
};
export type CoachingChatMessageInsert = Omit<CoachingChatMessageRow, "id" | "created_at"> & {
  id?: string;
  created_at?: string;
};
export type CoachingChatMessageUpdate = Partial<CoachingChatMessageInsert>;

/**
 * Minimal shape of the generated Supabase `Database` type, hand-maintained.
 * `Relationships` (and the schema-level `Views`/`Functions`) are required by
 * @supabase/postgrest-js's `GenericSchema` constraint even though we don't
 * use embedded-resource typing here — query results are cast explicitly in
 * src/lib/db/analyses.ts instead.
 */
/**
 * One shot, looked at closely.
 *
 * Written by the coaching pass's SECOND Gemini call, which re-watches a short
 * window around each shot at 15fps -- the first pass sees 1 frame per second
 * and a stroke lasts about a third of one, so it cannot see a swing at all.
 * See supabase/migrations/0013_shot_technique.sql.
 */
/*
 * A `type`, not an `interface`, and that is load-bearing rather than style.
 * Supabase's GenericTable requires Row to satisfy Record<string, unknown>. A
 * type alias gets an implicit index signature and satisfies it; an interface
 * does not. One table that fails stops the whole Database from matching
 * GenericSchema, at which point EVERY table in every file silently resolves to
 * `never` and hundreds of unrelated lines start failing. Every other Row here
 * is a type alias for the same reason.
 */
export type CoachingShotTechniqueRow = {
  id: string;
  analysis_id: string;
  t_s: number;
  striker_court: string | null;
  /** False is a real answer: the window held no stroke (between points, ball retrieval). */
  stroke_visible: boolean;
  paddle_face: string | null;
  contact_height: string | null;
  correction: string | null;
  confidence: string | null;
  /** The exact window judged — and therefore the exact window to play back. */
  clip_start_s: number;
  clip_end_s: number;
  created_at: string;
}

export type CoachingShotTechniqueInsert = Omit<CoachingShotTechniqueRow, "id" | "created_at"> & {
  id?: string;
  created_at?: string;
};

export type CoachingPracticePlanRow = {
  id: string;
  analysis_id: string;
  focus: string;
  total_minutes: number | null;
  /** What a later analysis can confirm or refute — the closed loop reads this. */
  success_looks_like: string | null;
  created_at: string;
};
export type CoachingPracticePlanInsert = Omit<CoachingPracticePlanRow, "id" | "created_at">
  & { id?: string; created_at?: string };

export type CoachingPracticeBlockRow = {
  id: string;
  plan_id: string;
  idx: number;
  kind: "warmup" | "drill" | "game" | "cooldown";
  name: string;
  drill_slug: string | null;
  minutes: number | null;
  how: string;
  success: string | null;
  targets: string | null;
  created_at: string;
};
export type CoachingPracticeBlockInsert = Omit<CoachingPracticeBlockRow, "id" | "created_at">
  & { id?: string; created_at?: string };

export type Database = {
  public: {
    Tables: {
      practice_plans: {
        Row: PracticePlanRow;
        Insert: PracticePlanInsert;
        Update: Partial<PracticePlanInsert>;
        Relationships: [];
      };
      practice_sessions: {
        Row: PracticeSessionRow;
        Insert: PracticeSessionInsert;
        Update: Partial<PracticeSessionInsert>;
        Relationships: [];
      };
      practice_session_drills: {
        Row: PracticeSessionDrillRow;
        Insert: PracticeSessionDrillInsert;
        Update: Partial<PracticeSessionDrillInsert>;
        Relationships: [];
      };
      coaching_practice_plans: {
        Row: CoachingPracticePlanRow;
        Insert: CoachingPracticePlanInsert;
        Update: Partial<CoachingPracticePlanInsert>;
        Relationships: [];
      };
      coaching_practice_blocks: {
        Row: CoachingPracticeBlockRow;
        Insert: CoachingPracticeBlockInsert;
        Update: Partial<CoachingPracticeBlockInsert>;
        Relationships: [];
      };
      coaching_shot_technique: {
        Row: CoachingShotTechniqueRow;
        Insert: CoachingShotTechniqueInsert;
        Update: Partial<CoachingShotTechniqueInsert>;
        Relationships: [];
      };
      profiles: {
        Row: ProfileRow;
        Insert: ProfileInsert;
        Update: ProfileUpdate;
        Relationships: [];
      };
      analyses: {
        Row: AnalysisRow;
        Insert: AnalysisInsert;
        Update: AnalysisUpdate;
        Relationships: [
          {
            foreignKeyName: "analyses_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      videos: {
        Row: VideoRow;
        Insert: VideoInsert;
        Update: VideoUpdate;
        Relationships: [
          {
            foreignKeyName: "videos_analysis_id_fkey";
            columns: ["analysis_id"];
            isOneToOne: true;
            referencedRelation: "analyses";
            referencedColumns: ["id"];
          },
        ];
      };
      court_calibrations: {
        Row: CourtCalibrationRow;
        Insert: CourtCalibrationInsert;
        Update: CourtCalibrationUpdate;
        Relationships: [
          {
            foreignKeyName: "court_calibrations_analysis_id_fkey";
            columns: ["analysis_id"];
            isOneToOne: true;
            referencedRelation: "analyses";
            referencedColumns: ["id"];
          },
        ];
      };
      analysis_frames: {
        Row: AnalysisFrameRow;
        Insert: AnalysisFrameInsert;
        Update: AnalysisFrameUpdate;
        Relationships: [
          {
            foreignKeyName: "analysis_frames_analysis_id_fkey";
            columns: ["analysis_id"];
            isOneToOne: false;
            referencedRelation: "analyses";
            referencedColumns: ["id"];
          },
        ];
      };
      player_tracks: {
        Row: PlayerTrackRow;
        Insert: PlayerTrackInsert;
        Update: PlayerTrackUpdate;
        Relationships: [
          {
            foreignKeyName: "player_tracks_analysis_id_fkey";
            columns: ["analysis_id"];
            isOneToOne: false;
            referencedRelation: "analyses";
            referencedColumns: ["id"];
          },
        ];
      };
      player_keypoints: {
        Row: PlayerKeypointRow;
        Insert: PlayerKeypointInsert;
        Update: PlayerKeypointUpdate;
        Relationships: [
          {
            foreignKeyName: "player_keypoints_analysis_id_fkey";
            columns: ["analysis_id"];
            isOneToOne: false;
            referencedRelation: "analyses";
            referencedColumns: ["id"];
          },
        ];
      };
      movement_metrics: {
        Row: MovementMetricRow;
        Insert: MovementMetricInsert;
        Update: MovementMetricUpdate;
        Relationships: [
          {
            foreignKeyName: "movement_metrics_analysis_id_fkey";
            columns: ["analysis_id"];
            isOneToOne: false;
            referencedRelation: "analyses";
            referencedColumns: ["id"];
          },
        ];
      };
      ball_tracks: {
        Row: BallTrackRow;
        Insert: BallTrackInsert;
        Update: BallTrackUpdate;
        Relationships: [
          {
            foreignKeyName: "ball_tracks_analysis_id_fkey";
            columns: ["analysis_id"];
            isOneToOne: true;
            referencedRelation: "analyses";
            referencedColumns: ["id"];
          },
        ];
      };
      analysis_rallies: {
        Row: AnalysisRallyRow;
        Insert: AnalysisRallyInsert;
        Update: AnalysisRallyUpdate;
        Relationships: [
          {
            foreignKeyName: "analysis_rallies_analysis_id_fkey";
            columns: ["analysis_id"];
            isOneToOne: false;
            referencedRelation: "analyses";
            referencedColumns: ["id"];
          },
        ];
      };
      analysis_quality: {
        Row: AnalysisQualityRow;
        Insert: AnalysisQualityInsert;
        Update: AnalysisQualityUpdate;
        Relationships: [
          {
            foreignKeyName: "analysis_quality_analysis_id_fkey";
            columns: ["analysis_id"];
            isOneToOne: true;
            referencedRelation: "analyses";
            referencedColumns: ["id"];
          },
        ];
      };
      analysis_shots: {
        Row: AnalysisShotRow;
        Insert: AnalysisShotInsert;
        Update: AnalysisShotUpdate;
        Relationships: [
          {
            foreignKeyName: "analysis_shots_analysis_id_fkey";
            columns: ["analysis_id"];
            isOneToOne: false;
            referencedRelation: "analyses";
            referencedColumns: ["id"];
          },
        ];
      };
      analysis_events: {
        Row: AnalysisEventRow;
        Insert: AnalysisEventInsert;
        Update: AnalysisEventUpdate;
        Relationships: [
          {
            foreignKeyName: "analysis_events_analysis_id_fkey";
            columns: ["analysis_id"];
            isOneToOne: false;
            referencedRelation: "analyses";
            referencedColumns: ["id"];
          },
        ];
      };
      coaching_rallies: {
        Row: CoachingRallyRow;
        Insert: CoachingRallyInsert;
        Update: CoachingRallyUpdate;
        Relationships: [
          {
            foreignKeyName: "coaching_rallies_analysis_id_fkey";
            columns: ["analysis_id"];
            isOneToOne: false;
            referencedRelation: "analyses";
            referencedColumns: ["id"];
          },
        ];
      };
      coaching_reads: {
        Row: CoachingReadRow;
        Insert: CoachingReadInsert;
        Update: CoachingReadUpdate;
        Relationships: [
          {
            foreignKeyName: "coaching_reads_analysis_id_fkey";
            columns: ["analysis_id"];
            isOneToOne: true;
            referencedRelation: "analyses";
            referencedColumns: ["id"];
          },
        ];
      };
      coaching_observations: {
        Row: CoachingObservationRow;
        Insert: CoachingObservationInsert;
        Update: CoachingObservationUpdate;
        Relationships: [
          {
            foreignKeyName: "coaching_observations_analysis_id_fkey";
            columns: ["analysis_id"];
            isOneToOne: false;
            referencedRelation: "analyses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "coaching_observations_read_id_fkey";
            columns: ["read_id"];
            isOneToOne: false;
            referencedRelation: "coaching_reads";
            referencedColumns: ["id"];
          },
        ];
      };
      coaching_skill_ratings: {
        Row: CoachingSkillRatingRow;
        Insert: CoachingSkillRatingInsert;
        Update: CoachingSkillRatingUpdate;
        Relationships: [
          {
            foreignKeyName: "coaching_skill_ratings_analysis_id_fkey";
            columns: ["analysis_id"];
            isOneToOne: false;
            referencedRelation: "analyses";
            referencedColumns: ["id"];
          },
        ];
      };
      coaching_drills: {
        Row: CoachingDrillRow;
        Insert: CoachingDrillInsert;
        Update: CoachingDrillUpdate;
        Relationships: [
          {
            foreignKeyName: "coaching_drills_progression_fkey";
            columns: ["progression"];
            isOneToOne: false;
            referencedRelation: "coaching_drills";
            referencedColumns: ["slug"];
          },
          {
            foreignKeyName: "coaching_drills_regression_fkey";
            columns: ["regression"];
            isOneToOne: false;
            referencedRelation: "coaching_drills";
            referencedColumns: ["slug"];
          },
        ];
      };
      coaching_blueprints: {
        Row: CoachingBlueprintRow;
        Insert: CoachingBlueprintInsert;
        Update: CoachingBlueprintUpdate;
        Relationships: [
          {
            foreignKeyName: "coaching_blueprints_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "coaching_blueprints_analysis_id_fkey";
            columns: ["analysis_id"];
            isOneToOne: false;
            referencedRelation: "analyses";
            referencedColumns: ["id"];
          },
        ];
      };
      coaching_blueprint_steps: {
        Row: CoachingBlueprintStepRow;
        Insert: CoachingBlueprintStepInsert;
        Update: CoachingBlueprintStepUpdate;
        Relationships: [
          {
            foreignKeyName: "coaching_blueprint_steps_blueprint_id_fkey";
            columns: ["blueprint_id"];
            isOneToOne: false;
            referencedRelation: "coaching_blueprints";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "coaching_blueprint_steps_drill_slug_fkey";
            columns: ["drill_slug"];
            isOneToOne: false;
            referencedRelation: "coaching_drills";
            referencedColumns: ["slug"];
          },
        ];
      };
      coaching_chat_messages: {
        Row: CoachingChatMessageRow;
        Insert: CoachingChatMessageInsert;
        Update: CoachingChatMessageUpdate;
        Relationships: [
          {
            foreignKeyName: "coaching_chat_messages_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
};
