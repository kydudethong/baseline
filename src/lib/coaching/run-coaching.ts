// Orchestrates the coaching-narrative stage: reads Rally IQ's already-
// persisted CV output for one analysis (player_tracks, player_keypoints,
// movement_metrics, analysis_events — written by pipeline-v2.ts), builds
// the honesty-scored facts payload (facts.ts), runs the two Claude calls
// (prompts.ts / claude.ts) ported from Baseline's original coaching layer,
// and persists the result into the coaching_* tables from
// supabase/migrations/0005_coaching_layer.sql.
//
// Deliberately a SEPARATE stage from the CV pipeline (pipeline-v2.ts), not
// a step tacked onto its end: it needs analyses.self_player_label, which
// can only be set once the player has told the app "which one is you" —
// see src/app/api/analyses/[id]/coach/route.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AnalysisEventRow,
  AnalysisRow,
  Database,
  MovementMetricRow,
  PlayerKeypointRow,
  PlayerTrackRow,
  ProfileRow,
} from "@/lib/db/types";
import { buildCoachingFacts } from "./facts";
import { generateJSON, resolveModel, textPart } from "./claude";
import { COACHING_READ_SCHEMA, TAGGING_SCHEMA, coachingReadPrompt, taggingPrompt } from "./prompts";
import type { CoachingRead, CoachingTagging } from "./types";

type Client = SupabaseClient<Database>;

export class CoachingPipelineError extends Error {}

export function kickOffCoachingPipeline(supabase: Client, userId: string, analysisId: string): void {
  runCoachingPipeline(supabase, userId, analysisId).catch((err) => {
    // runCoachingPipeline doesn't have an analysis-level "failed" status to
    // record into (that belongs to the CV pipeline) — this catch only
    // stops an unhandled rejection from crashing the dev server. Callers
    // that need to know whether it succeeded should await
    // runCoachingPipeline directly instead (see the coach API route).
    console.error(`[coaching] analysis ${analysisId} failed:`, err);
  });
}

export async function runCoachingPipeline(supabase: Client, userId: string, analysisId: string): Promise<void> {
  const { data: analysisData, error: analysisError } = await supabase
    .from("analyses")
    .select("*")
    .eq("id", analysisId)
    .eq("user_id", userId)
    .maybeSingle();
  if (analysisError) throw analysisError;
  const analysis = analysisData as AnalysisRow | null;
  if (!analysis) throw new CoachingPipelineError("Analysis not found");
  if (analysis.status !== "completed") {
    throw new CoachingPipelineError("The CV pipeline hasn't finished for this analysis yet.");
  }
  if (!analysis.self_player_label) {
    throw new CoachingPipelineError('No player has been tagged as "you" for this analysis yet.');
  }
  // Stored as a comma-separated list — a real player can span several
  // player_N labels since the tracker has no re-identification (see
  // facts.ts's mergeSelfFragments()).
  const selfPlayerLabels = analysis.self_player_label
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);

  const { data: profileData, error: profileError } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (profileError) throw profileError;
  const profile = profileData as ProfileRow | null;

  const [tracksRes, keypointsRes, movementRes, eventsRes] = await Promise.all([
    supabase.from("player_tracks").select("*").eq("analysis_id", analysisId),
    supabase.from("player_keypoints").select("*").eq("analysis_id", analysisId),
    supabase.from("movement_metrics").select("*").eq("analysis_id", analysisId),
    supabase.from("analysis_events").select("*").eq("analysis_id", analysisId),
  ]);
  if (tracksRes.error) throw tracksRes.error;
  if (keypointsRes.error) throw keypointsRes.error;
  if (movementRes.error) throw movementRes.error;
  if (eventsRes.error) throw eventsRes.error;

  const facts = buildCoachingFacts({
    selfPlayerLabels,
    tracks: (tracksRes.data ?? []) as PlayerTrackRow[],
    keypoints: (keypointsRes.data ?? []) as PlayerKeypointRow[],
    movement: (movementRes.data ?? []) as MovementMetricRow[],
    events: (eventsRes.data ?? []) as AnalysisEventRow[],
  });

  if (facts.rallies.length === 0) {
    // Still record an honest result rather than leaving the UI with
    // nothing to show — "we tried and there wasn't enough data" is itself
    // useful information, not a failure to hide.
    const { error } = await supabase.from("coaching_reads").upsert(
      {
        analysis_id: analysisId,
        model: null,
        headline: "Not enough audio-contact data to build a coaching read",
        summary:
          "No rally could be segmented from this clip's audio — either too few paddle contacts were " +
          "detected, or they weren't clustered closely enough to look like real rallies.",
        quality: { usable: false, issues: facts.known_limitations },
        coaching_json: null,
        facts_json: JSON.stringify(facts),
      },
      { onConflict: "analysis_id" }
    );
    if (error) throw error;
    return;
  }

  const coaching = await generateJSON<CoachingRead>(
    [
      textPart(
        coachingReadPrompt({
          skillLevel: profile?.skill_level ?? null,
          focusArea: analysis.coaching_notes,
          facts,
        })
      ),
    ],
    COACHING_READ_SCHEMA,
    0.4
  );

  const tagged = await generateJSON<CoachingTagging>(
    [
      textPart(
        taggingPrompt({
          skillLevel: profile?.skill_level ?? null,
          paddleHand: profile?.paddle_hand ?? null,
          coachingKind: analysis.coaching_kind,
          notes: analysis.coaching_notes,
          facts,
          coaching,
        })
      ),
    ],
    TAGGING_SCHEMA,
    0.3
  );

  const model = await resolveModel();

  const rallyRows = facts.rallies.map((r) => ({
    analysis_id: analysisId,
    idx: r.rally_number,
    start_s: r.start_s,
    end_s: r.end_s,
    shots: r.shots,
  }));
  const { error: rallyError } = await supabase
    .from("coaching_rallies")
    .upsert(rallyRows, { onConflict: "analysis_id,idx" });
  if (rallyError) throw rallyError;

  const { data: readRow, error: readError } = await supabase
    .from("coaching_reads")
    .upsert(
      {
        analysis_id: analysisId,
        model,
        headline: tagged.headline,
        summary: tagged.summary,
        quality: tagged.footage_quality,
        coaching_json: JSON.stringify(coaching),
        facts_json: JSON.stringify(facts),
      },
      { onConflict: "analysis_id" }
    )
    .select("id")
    .single();
  if (readError) throw readError;
  const readId = readRow.id;

  // Replace this read's observations/skill-ratings wholesale — a re-run
  // means new judgments, not an accumulating pile of old ones.
  const { error: deleteObsError } = await supabase.from("coaching_observations").delete().eq("read_id", readId);
  if (deleteObsError) throw deleteObsError;

  if (tagged.observations.length > 0) {
    const obsRows = tagged.observations.map((o) => ({
      analysis_id: analysisId,
      read_id: readId,
      rally_idx: o.rally_idx,
      t_s: null,
      skill_key: o.skill_key,
      coaching_dimension: o.coaching_dimension,
      valence: o.valence,
      title: o.title,
      detail: o.detail,
      severity: Math.max(1, Math.min(5, Math.round(o.severity))),
    }));
    const { error: insertObsError } = await supabase.from("coaching_observations").insert(obsRows);
    if (insertObsError) throw insertObsError;
  }

  if (tagged.skills.length > 0) {
    const skillRows = tagged.skills.map((s) => ({
      analysis_id: analysisId,
      skill_key: s.skill_key,
      raw: Math.max(1, Math.min(5, s.rating)),
      observations: tagged.observations.filter((o) => o.skill_key === s.skill_key).length,
      basis: s.basis,
    }));
    const { error: skillError } = await supabase
      .from("coaching_skill_ratings")
      .upsert(skillRows, { onConflict: "analysis_id,skill_key" });
    if (skillError) throw skillError;
  }
}
