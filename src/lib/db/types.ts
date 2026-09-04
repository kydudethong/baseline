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
  coaching_notes: string | null;
  coaching_kind: string;
  created_at: string;
  updated_at: string;
};
export type AnalysisInsert = {
  id?: string;
  user_id: string;
  title: string;
  status?: AnalysisStatus;
  error_message?: string | null;
  result?: AnalysisResult | null;
  self_player_label?: string | null;
  coaching_notes?: string | null;
  coaching_kind?: string;
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
  coaching_notes?: string | null;
  coaching_kind?: string;
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
  source: "audio-onset" | "movement-heuristic" | "mock";
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
  created_at: string;
};
export type AnalysisShotInsert = Omit<AnalysisShotRow, "id" | "created_at"> & { id?: string; created_at?: string };
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
};
export type CoachingObservationInsert = Omit<CoachingObservationRow, "id" | "dismissed"> & {
  id?: string;
  dismissed?: boolean;
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
export type Database = {
  public: {
    Tables: {
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
