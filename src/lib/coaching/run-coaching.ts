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

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
import { readShotTechnique } from "./technique";
import { buildPracticePlan } from "./practice-plan";
import { matchPlaystyles } from "./pro-playstyles";
import { shotRowsFromAnalyst } from "./shot-rows";
import { uploadVideo, deleteFile } from "./gemini";
import { downloadToFile } from "@/lib/storage/r2";
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
  const analysis = analysisData as (AnalysisRow & {
    video: { duration_seconds: number | null; storage_path: string | null } | null;
  }) | null;
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



  // PASS TWO: look closely at each shot.
  //
  // Pass one watched the OVERLAY at 1fps, which finds rallies and shots and
  // cannot see a swing -- a stroke is a third of a second, so at 1fps it falls
  // between two frames. This re-watches one short window per shot at 15fps.
  //
  // The SOURCE video, not the overlay: technique is read off the body, and the
  // overlay draws boxes and a skeleton over exactly the thing being judged.
  //
  // Failing here never fails the coaching read. The prose, rallies, ratings
  // and drills are already in hand; technique is an addition, and an addition
  // that takes the whole analysis down with it is a bad trade.
  try {
    const storagePath = analysis.video?.storage_path ?? null;
    const durationSeconds = Number(analysis.video?.duration_seconds ?? 0);
    const shotsWithTime = out.shots.filter((sh) => Number.isFinite(sh.t));
    if (storagePath && durationSeconds > 0 && shotsWithTime.length > 0) {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pb-technique-"));
      const local = path.join(dir, "source.mp4");
      try {
        await downloadToFile(storagePath, local);
        const bytes = await fsp.readFile(local);
        const file = await uploadVideo(bytes, `${analysisId}-source.mp4`);
        try {
          const { technique, patterns } = await readShotTechnique({
            model,
            file,
            durationSeconds,
            shots: shotsWithTime.map((sh) => ({ t: sh.t, player: sh.player })),
            // The tagged player(s). A real player can span several track
            // labels (no re-identification), which is why this is a list and
            // why analyses.self_player_label is stored comma-separated.
            subjectLabels: (analysis.self_player_label ?? "")
              .split(",")
              .map((l) => l.trim())
              .filter(Boolean),
            onLog: (l) => console.error(`[coaching] ${l}`),
          });
          // Patterns are the thing the per-shot pass could not produce: a
          // statement across several shots, which only something watching them
          // together can make. Logged for now rather than given a column --
          // the first question is whether they are any good on real footage,
          // and reading them off a run answers that without committing a
          // schema to them.
          for (const p of patterns) console.error(`[coaching] technique pattern: ${p}`);

          if (technique.length > 0) {
            // Replace rather than accumulate: a re-run of the same analysis
            // must not leave the previous run's reads beside the new ones,
            // indistinguishable from them.
            await supabase.from("coaching_shot_technique").delete().eq("analysis_id", analysisId);
            const { error } = await supabase.from("coaching_shot_technique").insert(
              technique.map((t) => ({
                analysis_id: analysisId,
                t_s: t.tSeconds,
                striker_court: t.strikerCourt,
                stroke_visible: t.strokeVisible,
                paddle_face: t.paddleFace,
                contact_height: t.contactHeight,
                correction: t.correction,
                confidence: t.confidence,
                clip_start_s: t.clipStartSeconds,
                clip_end_s: t.clipEndSeconds,
              }))
            );
            if (error) throw error;
          }
        } finally {
          await deleteFile(file.name).catch(() => {});
        }
      } finally {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch (err) {
    console.warn(`[coaching] per-shot technique skipped: ${describeError(err)}`);
  }

  // A session the player can actually run, from what the analysis found.
  //
  // Text-only and last: the video has already been watched twice, everything
  // this needs is in `out`, and it costs a fraction of a cent. Wrapped like the
  // technique pass because a missing practice plan is a missing nice-to-have --
  // the read, the ratings and the drills are already written by now, and losing
  // those to a failure in the final optional step would be absurd.
  try {
    const plan = await buildPracticePlan({
      model, analyst: out, drills: allDrills,
      onLog: (l) => console.error(`[coaching] ${l}`),
    });
    if (plan) {
      // Replace, never accumulate: a re-run must not leave last time's session
      // sitting beside this one, indistinguishable from it.
      await supabase.from("coaching_practice_plans").delete().eq("analysis_id", analysisId);
      const { data: planRow, error: planErr } = await supabase
        .from("coaching_practice_plans")
        .insert({
          analysis_id: analysisId,
          focus: plan.focus,
          total_minutes: plan.totalMinutes,
          success_looks_like: plan.successLooksLike,
        })
        .select()
        .single();
      if (planErr) throw planErr;
      const { error: blockErr } = await supabase.from("coaching_practice_blocks").insert(
        plan.blocks.map((b) => ({
          plan_id: planRow.id,
          idx: b.idx,
          kind: b.kind,
          name: b.name,
          drill_slug: b.drillSlug,
          minutes: b.minutes,
          how: b.how,
          success: b.success,
          targets: b.targets,
        }))
      );
      if (blockErr) throw blockErr;
    }
  } catch (err) {
    console.warn(`[coaching] practice plan skipped: ${describeError(err)}`);
  }

  // Rallies now come from the analyst, not the segmenter.
  const rallyRows = out.rallies.map((r) => ({
    analysis_id: analysisId,
    idx: r.idx,
    start_s: r.start_s,
    end_s: r.end_s,
    // Paddle contacts in this rally.
    //
    // THIS IS WHY THE PAGE SAID 0. It counted analystInput.contacts, which
    // came from the ball tracker's detected hits -- and ball tracking was
    // removed. The array has been empty on every run since, so every rally
    // stored shots: 0, the scoreboard summed zero and reported "0 paddle
    // contacts" over footage plainly full of them. A count derived from a
    // source that no longer exists does not report zero because there were
    // none; it reports zero because nobody is counting.
    //
    // The model watches the video and returns a shot per contact with the
    // rally it belongs to, so that is the count. Preferring rally_idx over a
    // timestamp window matters at rally boundaries: a contact that ends one
    // rally can sit within a rounding error of the next one's start, and the
    // model's own attribution is better than our arithmetic on its
    // timestamps. The window is the fallback for shots whose rally_idx is
    // missing or out of range.
    shots: countContacts(out.shots ?? [], r),
  }));
  const { error: rallyError } = await supabase
    .from("coaching_rallies")
    .upsert(rallyRows, { onConflict: "analysis_id,idx" });
  if (rallyError) throw rallyError;

  // The shots themselves, into the table that already exists for them.
  //
  // analysis_shots was written by the CV shot classifier, which went when ball
  // tracking did -- so it has been empty on every run since, and every reader
  // of it has been reporting zero as though it were a measurement. The model's
  // shots fit it exactly (same fourteen shot types, same landing vocabulary),
  // so they go here rather than into a parallel table.
  //
  // Replace, not append: a re-run must not leave the previous read's shots
  // beside the new ones. Failure here is logged, not thrown -- the coaching
  // read, ratings and drills are already written by this point, and losing
  // them to a shot table would be a bad trade.
  try {
    const shotRows = shotRowsFromAnalyst(analysisId, out.shots ?? []);
    await supabase.from("analysis_shots").delete().eq("analysis_id", analysisId);
    if (shotRows.length > 0) {
      const { error: shotError } = await supabase.from("analysis_shots").insert(shotRows);
      if (shotError) throw shotError;
      console.error(`[coaching] stored ${shotRows.length} paddle contact(s) across ${rallyRows.length} rall(ies)`);
    } else {
      console.error("[coaching] the model reported no paddle contacts for this clip");
    }
  } catch (err) {
    console.warn(`[coaching] storing shots failed: ${describeError(err)}`);
  }

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
          // ONLY the grounding problems. knownLimitations used to be
          // concatenated in here, and that was a category error with a visible
          // cost: they are prompt text written FOR THE MODEL ("the key is
          // absent, not null", "shot_sequence[].mechanics"), and a single
          // audit hit flipped `usable` to false and dumped four paragraphs of
          // pipeline documentation into a red box headed "Limited footage
          // quality" — which blamed the user's video for an internal note and
          // buried the one line that actually mattered.
          //
          // A grounding problem is a different kind of thing entirely: a rally
          // outside the clip, or a claim about something this pipeline cannot
          // see, means part of this read is about nothing. That is worth
          // interrupting someone for. A description of how the pipeline works
          // is not.
          issues: analyst.problems,
          // Kept, because they are genuinely useful when debugging a read that
          // looks wrong — just not in the user's face. facts_json below holds
          // the full input; this is the short version.
          notes: analystInput.knownLimitations,
        },
        coaching_json: JSON.stringify({
          strengths: out.coaching.strengths,
          top_priority_fix: out.coaching.top_priority_fix,
          secondary_observations: out.coaching.secondary,
          playstyle: out.playstyle,
          drills: out.drills,
          data_gaps: out.data_gaps,
          // Which pros this player's game most resembles, by the SHAPE of the
          // skill ratings rather than their level -- see pro-playstyles.ts.
          //
          // Computed here rather than asked of the model on purpose. A model
          // asked "who do they play like" will answer with whoever it has read
          // most about, every time, and the answer would not move when the
          // ratings did. This is a deterministic function of numbers already on
          // the page, so it is checkable: if it says you play like Parenteau,
          // the skill radar above shows why.
          //
          // Stored in this existing blob rather than a new table, so the
          // feature needs no migration.
          playstyle_match: matchPlaystyles(
            Object.fromEntries(out.skills.map((s) => [s.skill_key, s.rating]))
          ),
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

/** Contacts belonging to one rally, by the model's own attribution first. */
function countContacts(
  shots: ReadonlyArray<{ t: number; rally_idx?: number }>,
  rally: { idx: number; start_s: number; end_s: number }
): number {
  const byIndex = shots.filter((s) => s.rally_idx === rally.idx).length;
  if (byIndex > 0) return byIndex;
  return shots.filter((s) => Number.isFinite(s.t) && s.t >= rally.start_s && s.t <= rally.end_s).length;
}
