/**
 * One read, one shape: everything a frontend needs to render an analysis.
 *
 * This exists because rendering an analysis previously meant a page joining
 * eight tables by hand and knowing three things that are not obvious from the
 * schema:
 *
 *   1. `analysis_shots.rally_idx` is safe against `analysis_rallies` (written
 *      in the same persist, from the same rallies the shots were cut from) but
 *      NOT against `coaching_rallies`, which the coaching pass re-derives later
 *      by re-clustering contact timestamps and which disagrees on numbering and
 *      often on count. Joining the wrong pair silently attributes rally 1's
 *      shots to rally 2 and drops the last rally's entirely.
 *   2. Analyses processed before migration 0009 have no `analysis_rallies` at
 *      all, so the join has to fall back to `coaching_rallies` BY TIMESTAMP.
 *   3. Absent is not zero. A mechanics field that could not be measured must
 *      arrive as null and be rendered as "not available", never as 0.
 *
 * Doing that join once here means no page can get it wrong, and the fallback
 * means the 26 analyses that predate 0009 still render.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnalysisWithVideo } from "./analyses";
import type {
  AnalysisProgress, AnalysisQualityRow, AnalysisRallyRow, AnalysisShotRow,
  CoachingObservationRow, CoachingReadRow, CoachingSkillRatingRow,
  CourtCalibrationRow, Database, MovementMetricRow, PlayerTrackRow, RallyContact,
  ShotMechanicsRow,
} from "./types";
import type { BlueprintWithSteps } from "./blueprints";
import { getBlueprintsForAnalysis } from "./blueprints";
import type { PreAnalysisSetup } from "./setup";

type Client = SupabaseClient<Database>;

/** Where a rally's boundaries came from — a UI should be able to say. */
export type RallySource = AnalysisRallyRow["source"] | "coaching-reclustered";

export interface ViewShot {
  rallyIdx: number;
  shotIdx: number;
  t: number;
  playerLabel: string | null;
  isSelf: boolean;
  type: string;
  category: string;
  hitZone: string;
  landingZone: string;
  speedMps: number | null;
  arcNorm: number | null;
  bouncedBefore: boolean | null;
  outcome: string;
  confidence: number;
  /** The rule that fired, plus the numbers it fired on. */
  features: Record<string, unknown> | null;
  /** Null means NOT MEASURED. Never render a null field as 0. */
  mechanics: ShotMechanicsRow | null;
}

export interface ViewRally {
  idx: number;
  startS: number;
  endS: number;
  durationS: number;
  source: RallySource;
  /** Null where the segmenter genuinely does not know why it ended. */
  endReason: string | null;
  contactCount: number;
  crossingCount: number | null;
  extendedSeconds: number;
  contacts: RallyContact[];
  /** Null until the coaching pass judges it. Show as "no verdict", not neutral. */
  verdict: AnalysisRallyRow["verdict"];
  verdictReason: string | null;
  verdictConfidence: number | null;
  shots: ViewShot[];
}

export interface ViewPlayer {
  label: string;
  isSelf: boolean;
  firstSeenS: number;
  lastSeenS: number;
  /** Null when court calibration failed — the distance is unknown, not zero. */
  distanceMeters: number | null;
  averageSpeed: number | null;
  maxSpeed: number | null;
  coverage: { xMin: number; xMax: number; yMin: number; yMax: number } | null;
}

export interface AnalysisView {
  analysis: {
    id: string;
    title: string;
    status: AnalysisWithVideo["status"];
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
    coachingKind: string;
    /** Every track label the user identified as themselves (the tracker has no re-ID). */
    selfPlayerLabels: string[];
    progress: AnalysisProgress | null;
  };
  video: {
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
    storagePath: string;
  } | null;
  setup: PreAnalysisSetup | null;
  court: {
    method: string;
    confidence: number;
    cornersImagePx: unknown;
    quadKind: string | null;
    /** True when the user marked it themselves, so a UI need not warn about it. */
    userConfirmed: boolean;
  } | null;
  quality: AnalysisQualityRow | null;
  rallies: ViewRally[];
  shots: ViewShot[];
  players: ViewPlayer[];
  coaching: {
    headline: string;
    summary: string;
    /** The player-facing read, parsed. Null when the model could not produce one. */
    read: unknown | null;
    quality: unknown | null;
    observations: CoachingObservationRow[];
    skills: CoachingSkillRatingRow[];
  } | null;
  blueprints: BlueprintWithSteps[];
  /** True when rally boundaries came from the coaching re-clustering, not the segmenter. */
  ralliesAreReDerived: boolean;
}

function toViewShot(r: AnalysisShotRow, selfLabels: Set<string>): ViewShot {
  return {
    rallyIdx: r.rally_idx,
    shotIdx: r.shot_idx,
    t: Number(r.timestamp_s),
    playerLabel: r.player_label,
    isSelf: r.player_label !== null && selfLabels.has(r.player_label),
    type: r.shot_type,
    category: r.category,
    hitZone: r.hit_zone,
    landingZone: r.landing_zone,
    speedMps: r.speed_mps_approx,
    arcNorm: r.arc_norm,
    bouncedBefore: r.bounced_before,
    outcome: r.outcome,
    confidence: Number(r.confidence),
    features: (r.features as Record<string, unknown> | null) ?? null,
    // Preserved as null rather than defaulted. This is the single most
    // important line in the file for the product's honesty claim.
    mechanics: (r.mechanics as ShotMechanicsRow | null) ?? null,
  };
}

export async function getAnalysisView(
  supabase: Client,
  analysis: AnalysisWithVideo
): Promise<AnalysisView> {
  const id = analysis.id;
  const [
    calibrationRes, qualityRes, ralliesRes, shotsRes, tracksRes, movementRes,
    coachingReadRes, obsRes, skillsRes, coachingRalliesRes, blueprints,
  ] = await Promise.all([
    supabase.from("court_calibrations").select("*").eq("analysis_id", id).maybeSingle(),
    supabase.from("analysis_quality").select("*").eq("analysis_id", id).maybeSingle(),
    supabase.from("analysis_rallies").select("*").eq("analysis_id", id).order("idx"),
    supabase.from("analysis_shots").select("*").eq("analysis_id", id).order("timestamp_s"),
    supabase.from("player_tracks").select("*").eq("analysis_id", id).order("player_label"),
    supabase.from("movement_metrics").select("*").eq("analysis_id", id).order("player_label"),
    supabase.from("coaching_reads").select("*").eq("analysis_id", id).maybeSingle(),
    supabase.from("coaching_observations").select("*").eq("analysis_id", id)
      .eq("dismissed", false).order("severity", { ascending: false }),
    supabase.from("coaching_skill_ratings").select("*").eq("analysis_id", id),
    supabase.from("coaching_rallies").select("*").eq("analysis_id", id).order("idx"),
    getBlueprintsForAnalysis(supabase, id),
  ]);

  // self_player_label is a comma-separated LIST, not one label: the tracker has
  // no re-identification, so one real person routinely spans several labels.
  const selfLabels = new Set<string>(
    (analysis.self_player_label ?? "").split(",")
      .map((label: string) => label.trim())
      .filter((label: string) => label.length > 0)
  );

  const shotRows = (shotsRes.data as AnalysisShotRow[] | null) ?? [];
  const shots = shotRows.map((r) => toViewShot(r, selfLabels));

  const segmenterRallies = (ralliesRes.data as AnalysisRallyRow[] | null) ?? [];
  let rallies: ViewRally[];
  let ralliesAreReDerived = false;

  if (segmenterRallies.length > 0) {
    // The safe join: same run, same array, same numbering.
    rallies = segmenterRallies.map((r) => ({
      idx: r.idx,
      startS: Number(r.start_s),
      endS: Number(r.end_s),
      durationS: Math.round((Number(r.end_s) - Number(r.start_s)) * 10) / 10,
      source: r.source,
      endReason: r.end_reason,
      contactCount: r.contact_count,
      crossingCount: r.crossing_count,
      extendedSeconds: Number(r.extended_seconds),
      contacts: (r.contacts as RallyContact[] | null) ?? [],
      verdict: r.verdict,
      verdictReason: r.verdict_reason,
      verdictConfidence: r.verdict_confidence,
      shots: shots.filter((s) => s.rallyIdx === r.idx).sort((a, b) => a.t - b.t),
    }));
  } else {
    // Pre-0009 analyses. coaching_rallies is a re-derivation with its own
    // numbering, so shots MUST be matched by timestamp here — using rally_idx
    // would attribute them to the wrong rally.
    const cr = (coachingRalliesRes.data as Array<{ idx: number; start_s: number; end_s: number; shots: number }> | null) ?? [];
    ralliesAreReDerived = cr.length > 0;
    rallies = cr.map((r) => {
      const startS = Number(r.start_s), endS = Number(r.end_s);
      return {
        idx: r.idx, startS, endS,
        durationS: Math.round((endS - startS) * 10) / 10,
        source: "coaching-reclustered" as const,
        endReason: null,
        contactCount: r.shots,
        crossingCount: null,
        extendedSeconds: 0,
        contacts: [],
        verdict: null, verdictReason: null, verdictConfidence: null,
        shots: shots.filter((s) => s.t >= startS && s.t <= endS).sort((a, b) => a.t - b.t),
      };
    });
  }

  const movementByLabel = new Map(
    ((movementRes.data as MovementMetricRow[] | null) ?? []).map((m) => [m.player_label, m])
  );
  const players: ViewPlayer[] = ((tracksRes.data as PlayerTrackRow[] | null) ?? []).map((t) => {
    const m = movementByLabel.get(t.player_label);
    return {
      label: t.player_label,
      isSelf: selfLabels.has(t.player_label),
      firstSeenS: Number(t.first_seen_s),
      lastSeenS: Number(t.last_seen_s),
      // Null, not 0: these are null in the database whenever calibration failed,
      // and "we could not measure your distance" is a different statement from
      // "you covered no ground".
      distanceMeters: m?.distance_covered_meters_approx ?? null,
      averageSpeed: m?.average_speed_court_units_s ?? null,
      maxSpeed: m?.max_speed_court_units_s ?? null,
      coverage: (m?.court_coverage_bounds as ViewPlayer["coverage"]) ?? null,
    };
  }).sort((a, b) => Number(b.isSelf) - Number(a.isSelf));

  const cal = calibrationRes.data as CourtCalibrationRow | null;
  const read = coachingReadRes.data as CoachingReadRow | null;

  return {
    analysis: {
      id, title: analysis.title, status: analysis.status,
      errorMessage: analysis.error_message,
      createdAt: analysis.created_at, updatedAt: analysis.updated_at,
      coachingKind: analysis.coaching_kind,
      selfPlayerLabels: [...selfLabels],
      progress: (analysis.progress as AnalysisProgress | null) ?? null,
    },
    video: analysis.video ? {
      durationSeconds: analysis.video.duration_seconds,
      width: analysis.video.width,
      height: analysis.video.height,
      storagePath: analysis.video.storage_path,
    } : null,
    setup: (analysis.pre_analysis_setup as PreAnalysisSetup | null) ?? null,
    court: cal ? {
      method: cal.method,
      confidence: Number(cal.confidence),
      cornersImagePx: cal.corners_image_px,
      quadKind: ((cal.diagnostics as { quadKind?: string } | null)?.quadKind) ?? null,
      // The user marked it, so a "low confidence" warning would be wrong.
      userConfirmed: cal.method === "manual"
        || (cal.diagnostics as { source?: string } | null)?.source === "pre-analysis-setup",
    } : null,
    quality: (qualityRes.data as AnalysisQualityRow | null) ?? null,
    rallies,
    shots,
    players,
    coaching: read ? {
      // Nullable in the schema: a read that failed to produce prose still has a
      // row, and empty is honest where a placeholder sentence would not be.
      headline: read.headline ?? "",
      summary: read.summary ?? "",
      // Stored as TEXT, so this is the one place that parses it. A malformed
      // blob returns null rather than throwing: the rest of the analysis is
      // still worth showing.
      read: safeParse(read.coaching_json),
      quality: read.quality,
      observations: (obsRes.data as CoachingObservationRow[] | null) ?? [],
      skills: (skillsRes.data as CoachingSkillRatingRow[] | null) ?? [],
    } : null,
    blueprints,
    ralliesAreReDerived,
  };
}

function safeParse(text: string | null): unknown | null {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
