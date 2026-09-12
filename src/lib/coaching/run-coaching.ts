// Orchestrates the coaching stage: reads the CV output already persisted for
// one analysis, builds the measured facts (analyst-facts.ts), runs ONE Gemini
// call over the annotated overlay plus those facts (analyst.ts), and persists
// the result into the coaching_* tables from
// supabase/migrations/0005_coaching_layer.sql.
//
// It used to be two Claude calls -- a coaching read, then a tagging pass over
// the same facts plus that read, arranged so the two could not contradict
// each other. One call cannot contradict itself, and the rallies, shot types
// and ratings now come from the same reading of the same video as the prose
// about them.
//
// The overlay is an INPUT here, not a debug artefact. A run without one
// cannot be coached, and says so.
//
// Deliberately a SEPARATE stage from the CV pipeline (pipeline-v2.ts), not
// a step tacked onto its end: it needs analyses.self_player_label, which
// can only be set once the player has told the app "which one is you" —
// see src/app/api/analyses/[id]/coach/route.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AnalysisEventRow,
  AnalysisRow,
  AnalysisShotRow,
  BallTrackRow,
  Database,
  MovementMetricRow,
  PlayerKeypointRow,
  PlayerTrackRow,
  ProfileRow,
} from "@/lib/db/types";
import { buildCoachingFacts } from "./facts";
import { buildAnalystInput } from "./analyst-facts";
import { runAnalyst } from "./analyst";
import { readOverlayBytes, OverlayMissingError } from "./overlay-source";
import { OVERLAY_LEGEND } from "./overlay-legend";
import { getAllDrills } from "./drills";
import type { CoachingDrillRow } from "@/lib/db/types";
import { describeError } from "@/lib/analysis/describe-error";

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
    // The video row comes too: the analyst needs the clip's real length to
    // bound every timestamp it reports, and a wrong length there is how a
    // rally lands after the end of the footage.
    .select("*, video:videos(*)")
    .eq("id", analysisId)
    .eq("user_id", userId)
    .maybeSingle();
  if (analysisError) throw analysisError;
  const analysis = analysisData as (AnalysisRow & { video: { duration_seconds: number | null } | null }) | null;
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

  const [tracksRes, keypointsRes, movementRes, eventsRes, shotsRes, ballRes] = await Promise.all([
    supabase.from("player_tracks").select("*").eq("analysis_id", analysisId),
    supabase.from("player_keypoints").select("*").eq("analysis_id", analysisId),
    supabase.from("movement_metrics").select("*").eq("analysis_id", analysisId),
    supabase.from("analysis_events").select("*").eq("analysis_id", analysisId),
    supabase.from("analysis_shots").select("*").eq("analysis_id", analysisId),
    supabase.from("ball_tracks").select("*").eq("analysis_id", analysisId).maybeSingle(),
  ]);
  if (tracksRes.error) throw tracksRes.error;
  if (keypointsRes.error) throw keypointsRes.error;
  if (movementRes.error) throw movementRes.error;
  if (eventsRes.error) throw eventsRes.error;
  if (shotsRes.error) throw shotsRes.error;
  if (ballRes.error) throw ballRes.error;

  const facts = buildCoachingFacts({
    selfPlayerLabels,
    tracks: (tracksRes.data ?? []) as PlayerTrackRow[],
    keypoints: (keypointsRes.data ?? []) as PlayerKeypointRow[],
    movement: (movementRes.data ?? []) as MovementMetricRow[],
    events: (eventsRes.data ?? []) as AnalysisEventRow[],
    shots: (shotsRes.data ?? []) as AnalysisShotRow[],
    ballTrack: (ballRes.data as BallTrackRow | null) ?? null,
  });

  // Clear the previous read's derived rows before writing this one.
  //
  // These were upserted but never pruned, so a re-run that found fewer
  // rallies or rated fewer skills left the extras behind, indistinguishable
  // from fresh ones -- and the "not enough data" branch below returned early
  // without touching them at all, so a failed re-run showed its own headline
  // above a full set of observations and ratings from the run before.
  const pruneStale = async () => {
    for (const table of ["coaching_rallies", "coaching_skill_ratings"] as const) {
      const { error } = await supabase.from(table).delete().eq("analysis_id", analysisId);
      if (error) throw new Error(`clearing ${table}: ${describeError(error)}`);
    }
  };
  await pruneStale();

  // NO RALLY GATE HERE ANY MORE, and its removal is the point of the change.
  //
  // This used to read `if (facts.rallies.length === 0) return` with a stored
  // headline of "Not enough movement data to build a coaching read" -- so when
  // the local segmenter found nothing, Gemini was never asked. That inverted
  // the architecture: the component that is WORSE at finding rallies (it
  // missed boundaries Gemini caught, twice confirmed against the footage) got
  // to veto the one that is better, on exactly the clips where it had already
  // failed. A bad court fit or a sparse ball track produced silence instead of
  // an answer.
  //
  // Nothing local segments rallies now, so facts.rallies is always empty and
  // this gate would reject every clip. Gemini reads boundaries off the overlay
  // and the contact list; if there is genuinely nothing to see it says so
  // itself, which is a better answer than ours and arrives the same way.
  //
  // The message was also wrong on its own terms: it blamed "player movement",
  // which stopped being the rally signal long before this.

  const allDrills: CoachingDrillRow[] = await getAllDrills(supabase);
  const validSlugs = new Set(allDrills.map((d: CoachingDrillRow) => d.slug));

  // ONE call, over the overlay video plus what was measured.
  //
  // This replaced a coaching read and a separate tagging pass over the same
  // facts plus that read -- two calls arranged so they could not contradict
  // each other. A single call cannot contradict itself, and the rallies and
  // ratings now come from the same reading of the same video as the prose
  // about them.
  const analystInput = buildAnalystInput({
    clipSeconds: Number(analysis.video?.duration_seconds ?? 0),
    subjectPlayerId: analysis.self_player_label ?? null,
    shots: (shotsRes.data ?? []) as AnalysisShotRow[],
    ballTrack: (ballRes.data as BallTrackRow | null) ?? null,
    movement: (movementRes.data ?? []) as MovementMetricRow[],
    courtConfidence: null,
    skillLevel: profile?.skill_level ?? null,
    focusArea: analysis.coaching_notes,
    // The real catalogue, so a cited slug resolves to a drill that exists.
    drillCatalogue: allDrills.map((d: CoachingDrillRow) => ({ slug: d.slug, name: d.name, skill: d.skill_key })),
    knownLimitations: facts.known_limitations,
  });

  let analyst;
  try {
    const overlay = await readOverlayBytes(
      analysisId, analysis.debug_video_bucket ?? null, analysis.debug_video_path ?? null
    );
    analyst = await runAnalyst({
      videoBytes: overlay,
      videoName: `${analysisId}.mp4`,
      input: analystInput,
      legend: OVERLAY_LEGEND,
      onLog: (line) => console.error(`[coaching] ${line}`),
    });
  } catch (err) {
    if (err instanceof OverlayMissingError) {
      // Not a crash. The analysis itself succeeded; it simply cannot be
      // coached without the video the coaching is read from, and saying that
      // is more useful than a stack trace.
      throw new CoachingPipelineError(err.message);
    }
    throw err;
  }

  const out = analyst.output;
  const model = analyst.model;
  if (analyst.problems.length) {
    console.error(`[coaching] ${analyst.problems.length} grounding problem(s) in the analyst's answer`);
  }



  // Rallies now come from the analyst, not the segmenter.
  const rallyRows = out.rallies.map((r) => ({
    analysis_id: analysisId,
    idx: r.idx,
    start_s: r.start_s,
    end_s: r.end_s,
    // How many measured contacts fall inside it. Counted here rather than
    // taken from the model: a count is arithmetic over timestamps we already
    // have, and there is no reason to let it be wrong.
    shots: analystInput.contacts.filter((c) => c.t >= r.start_s && c.t <= r.end_s).length,
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
        headline: out.coaching.headline,
        summary: out.coaching.summary,
        quality: {
          usable: analyst.problems.length === 0,
          // The grounding problems ARE footage-quality issues as far as the
          // reader is concerned: a rally outside the clip or a shot at a time
          // nothing was measured means this read is partly about nothing.
          issues: [...analystInput.knownLimitations, ...analyst.problems],
        },
        coaching_json: JSON.stringify({
          strengths: out.coaching.strengths,
          top_priority_fix: out.coaching.top_priority_fix,
          secondary_observations: out.coaching.secondary,
          playstyle: out.playstyle,
          drills: out.drills,
          data_gaps: out.data_gaps,
        }),
        facts_json: JSON.stringify(analystInput),
      },
      { onConflict: "analysis_id" }
    )
    .select("id")
    .single();
  if (readError) throw readError;
  const readId = readRow.id;

  const { error: deleteObsError } = await supabase.from("coaching_observations").delete().eq("read_id", readId);
  if (deleteObsError) throw deleteObsError;

  // shot_t -> shot_idx. The model cites a CONTACT TIME because that is what it
  // was given and what it can get right; the column wants the index of a shot
  // row. Matched within a tenth of a second, and dropped rather than guessed
  // when nothing is that close -- an observation pinned to the wrong shot
  // shows the user the wrong moment, which is worse than showing none.
  const shotRows = (shotsRes.data ?? []) as AnalysisShotRow[];
  const shotIdxAt = (t: number | null): number | null => {
    if (t === null || !Number.isFinite(t)) return null;
    let best: AnalysisShotRow | null = null;
    let bestDt = 0.1;
    for (const s of shotRows) {
      const dt = Math.abs(Number(s.timestamp_s) - t);
      if (dt <= bestDt) { bestDt = dt; best = s; }
    }
    return best ? best.shot_idx : null;
  };

  if (out.observations.length > 0) {
    const obsRows = out.observations.map((o) => ({
      analysis_id: analysisId,
      read_id: readId,
      rally_idx: o.rally_idx,
      t_s: o.shot_t ?? null,
      skill_key: o.skill_key,
      coaching_dimension: o.coaching_dimension,
      valence: o.valence,
      title: o.title,
      detail: o.detail,
      severity: Math.max(1, Math.min(5, Math.round(o.severity))),
      // Absent stays absent: an empty string renders as an empty section
      // rather than as "we did not say".
      why_it_matters: o.why_it_matters?.trim() || null,
      what_to_change: o.what_to_change?.trim() || null,
      // A slug the model invented would break the foreign key AND point the
      // player at a drill that does not exist. Drop it rather than fail.
      drill_slug: o.drill_slug && validSlugs.has(o.drill_slug) ? o.drill_slug : null,
      shot_idx: shotIdxAt(o.shot_t),
    }));
    const { error: insertObsError } = await supabase.from("coaching_observations").insert(obsRows);
    if (insertObsError) throw insertObsError;
  }

  if (out.skills.length > 0) {
    const skillRows = out.skills.map((s) => ({
      analysis_id: analysisId,
      skill_key: s.skill_key,
      raw: Math.max(1, Math.min(5, Math.round(s.rating))),
      observations: out.observations.filter((o) => o.skill_key === s.skill_key).length,
      basis: s.basis,
    }));
    const { error: skillError } = await supabase
      .from("coaching_skill_ratings")
      .upsert(skillRows, { onConflict: "analysis_id,skill_key" });
    if (skillError) throw skillError;
  }
}
