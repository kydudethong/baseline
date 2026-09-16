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
import { runAnalyst, releaseAnalystFile, analystFps, analystMediaResolution } from "./analyst";
import { readTechnique } from "./technique-pass";
import { buildPracticePlan } from "./practice-plan";
import { matchPlaystyles } from "./pro-playstyles";
import { shotRowsFromAnalyst } from "./shot-rows";
import { fillApproachTimes } from "./approach-times";
import { activeWindows } from "./active-windows";
import { recordCapture } from "./capture";
import { readOverlayBytes, OverlayMissingError } from "./overlay-source";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { downloadToFile } from "@/lib/storage/r2";
import { cutEvidenceClips } from "./evidence-clips";
import { OVERLAY_LEGEND } from "./overlay-legend";
import { getAllDrills } from "./drills";
import type { CoachingDrillRow } from "@/lib/db/types";
import { describeError } from "@/lib/analysis/describe-error";

type Client = SupabaseClient<Database>;

export class CoachingPipelineError extends Error {}

/**
 * Start a coaching run and return immediately.
 *
 * WHY THIS IS NOW THE ONLY WAY IT RUNS. The coach route used to await the
 * whole pipeline inside the HTTP request that started it: upload, several
 * segments of video, a practice plan. That held a browser connection open for
 * minutes, so closing the laptop killed the run, and any proxy between the two
 * could time out a request that was working perfectly.
 *
 * The CV pipeline solved this long ago -- it answers straight away and keeps
 * going on the Node event loop, which is the whole reason this app is a
 * long-lived container rather than serverless (see the Dockerfile). Coaching
 * now does the same, and reports through analyses.progress like everything
 * else.
 */
export function kickOffCoachingPipeline(supabase: Client, userId: string, analysisId: string): void {
  void coachingProgress(supabase, analysisId, "Starting the coaching read…");
  runCoachingPipeline(supabase, userId, analysisId)
    .then(() => coachingProgress(supabase, analysisId, "Coaching read finished.", { done: true }))
    .catch(async (err) => {
      // The one place a background failure can still be seen. Without this the
      // page polls forever on a run that died thirty seconds in.
      await coachingProgress(supabase, analysisId, "Coaching read failed.", {
        error: describeError(err),
      }).catch(() => {});
    });
}

/**
 * Write one line of coaching progress onto the analysis row.
 *
 * Best-effort throughout: this is how a waiting page learns what is happening,
 * and a failure to write it must never take down the run it is describing.
 * `heartbeat_at` goes with every write for the same reason the CV pipeline
 * stamps it -- a stage label is the last value WRITTEN, so it cannot tell a
 * working run from a dead one, and only a recent heartbeat can.
 */
export async function coachingProgress(
  supabase: Client,
  analysisId: string,
  message: string,
  opts: { done?: boolean; error?: string } = {}
): Promise<void> {
  try {
    await supabase
      .from("analyses")
      .update({
        progress: {
          stage: "coaching",
          message,
          completedStages: [],
          updatedAt: new Date().toISOString(),
          ...(opts.done ? { coachingDone: true } : {}),
          ...(opts.error ? { error: opts.error } : {}),
        },
        heartbeat_at: new Date().toISOString(),
      })
      .eq("id", analysisId);
  } catch {
    // Reporting progress is not the job; doing the work is.
  }
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
    // width/height too: the approach-time pass re-derives court positions from
    // the raw tracks, and that projection is in pixels before it is in feet.
    video: {
      duration_seconds: number | null; storage_path: string | null;
      width: number | null; height: number | null;
    } | null;
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
  //
  // CALLED AT THE WRITE, NOT HERE. This used to run at the top of the
  // pipeline, which meant pressing "change who you are" deleted the rallies
  // BEFORE asking Gemini for new ones -- and every way the run could then fail
  // (no overlay, a model error, a network blip) left the analysis reporting
  // "no rallies were found in this clip" over footage that had a dozen. The
  // user's own words: changing who they were deleted the rallies.
  //
  // A destructive step belongs next to the write it makes room for, where the
  // replacement is already in hand and the gap between delete and insert is
  // one statement rather than the entire expensive half of the pipeline.
  const pruneStale = async () => {
    for (const table of ["coaching_rallies", "coaching_skill_ratings"] as const) {
      const { error } = await supabase.from(table).delete().eq("analysis_id", analysisId);
      if (error) throw new Error(`clearing ${table}: ${describeError(error)}`);
    }
  };

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
    // Where the play actually is, from the tracks already loaded above. Free:
    // no extra call, no extra token, and it is the single largest lever on
    // what an analysis costs -- roughly half a recreational game is people
    // walking to fetch a ball, and the model was being charged full price at
    // 10fps and high resolution to watch all of it.
    const gate = activeWindows(
      (tracksRes.data ?? []).map((t) =>
        ((t.points as Array<{ timestampSeconds: number; boxImageNorm?: { x: number; y: number } }> | null) ?? [])
          .filter((pt) => pt.boxImageNorm)
          .map((pt) => ({
            timestampSeconds: pt.timestampSeconds,
            x: pt.boxImageNorm!.x,
            y: pt.boxImageNorm!.y,
          }))
      ),
      Number(analysis.video?.duration_seconds ?? 0)
    );
    console.error(
      gate.gated
        ? `[coaching] watching ${Math.round(gate.coverage * 100)}% of the clip — `
          + `${gate.windows.length} stretch(es) where players were actually moving`
        : "[coaching] watching the whole clip — the tracks gave no clear split between play and dead time"
    );

    await coachingProgress(supabase, analysisId, gate.gated
      ? `Watching the ${gate.windows.length} stretches where you were playing…`
      : "Watching the clip…");
    const scanStartedAt = Date.now();
    analyst = await runAnalyst({
      videoBytes: overlay,
      videoName: `${analysisId}.mp4`,
      input: analystInput,
      legend: OVERLAY_LEGEND,
      activeWindows: gate.gated ? gate.windows : undefined,
      onLog: (line) => console.error(`[coaching] ${line}`),
    });
    // The record. Config first, because it is what makes a later correction
    // attributable: "wrong at 5fps low resolution" is a fixable claim, "wrong"
    // is not.
    await recordCapture(supabase, {
      analysisId,
      pass: "scan",
      model: analyst.model,
      config: {
        fps: analystFps(),
        mediaResolution: analystMediaResolution(),
        gated: gate.gated,
        coverage: gate.coverage,
        windows: gate.gated ? gate.windows : null,
        clipSeconds: analystInput.clipSeconds,
      },
      output: analyst.output,
      usage: { auditProblems: analyst.problems.length },
      durationMs: Date.now() - scanStartedAt,
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



  // TECHNIQUE: a second pass, narrow and expensive, only where a swing is.
  //
  // The scan above runs at 5fps and LOW resolution -- plenty to see a ball
  // change direction against a paddle, nowhere near enough to see the swing
  // that did it. This re-watches the windows around the subject's own contacts
  // at 10fps and high resolution.
  //
  // WHY SPLIT AGAIN, having just merged them. One pass at 10fps high
  // resolution over a whole match is ~3M tokens, and almost all of them buy
  // nothing: the reader is judged on about fifteen swings, under two seconds
  // each. Roughly 27 seconds of a 20-minute match is worth looking at closely;
  // the rest was costing full price to establish, over and over, that nobody
  // was mid-stroke. Same information, about a sixth of the bill.
  //
  // It reuses the OVERLAY upload rather than uploading the source video again:
  // the boxes cost some clarity on the body, and a second upload of a 500MB
  // clip costs a minute of wall clock on every single run.
  try {
    const subjectLabels = new Set(
      (analysis.self_player_label ?? "").split(",").map((l) => l.trim()).filter(Boolean)
        .map((l) => l.toLowerCase().replace(/[^a-z0-9]/g, ""))
    );
    const mine = (out.shots ?? [])
      .filter((sh) => Number.isFinite(sh.t))
      .filter((sh) => subjectLabels.size === 0
        || subjectLabels.has(String(sh.player ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")))
      .map((sh) => sh.t);

    const techniqueStartedAt = Date.now();
    const { technique, patterns } = analyst.file
      ? await readTechnique({
          model,
          file: analyst.file,
          shotTimes: mine,
          durationSeconds: Number(analysis.video?.duration_seconds ?? 0),
          playerLabel: analysis.self_player_label ?? null,
          onLog: (l) => console.error(`[coaching] ${l}`),
        })
      : { technique: [], patterns: [] as string[] };

    // Patterns are what a burst can say and a single shot cannot: "your first
    // two drops cleared the net and the third clipped it". Logged rather than
    // given a column while the open question is whether they are any good.
    for (const pat of patterns) console.error(`[coaching] technique pattern: ${pat}`);

    await recordCapture(supabase, {
      analysisId,
      pass: "technique",
      model,
      config: { fps: 10, mediaResolution: "high", shotTimes: mine },
      output: { technique, patterns },
      durationMs: Date.now() - techniqueStartedAt,
    });

    if (technique.length > 0) {
      await supabase.from("coaching_shot_technique").delete().eq("analysis_id", analysisId);
      const { error } = await supabase.from("coaching_shot_technique").insert(
        technique.map((t) => ({
          analysis_id: analysisId,
          t_s: t.tSeconds,
          striker_court: null,
          stroke_visible: t.strokeVisible,
          paddle_face: t.paddleFace,
          contact_height: t.contactHeight,
          shoulder_rotation: t.shoulderRotation,
          foot_position: t.footPosition,
          correction: t.correction,
          confidence: t.confidence,
          clip_start_s: t.clipStartSeconds,
          clip_end_s: t.clipEndSeconds,
        }))
      );
      if (error) throw error;
    }
  } catch (err) {
    console.warn(`[coaching] technique skipped: ${describeError(err)}`);
  } finally {
    // The upload was kept alive across both passes; it is finished with now.
    await releaseAnalystFile(analyst.file);
  }

  await coachingProgress(supabase, analysisId, "Measuring where you stood…");

  // Time to the kitchen after a return -- the half of the positioning metrics
  // the vision run could not compute, because the trigger is a shot type and
  // shot types are the model's judgement now.
  await fillApproachTimes(
    supabase,
    analysisId,
    (out.shots ?? []).filter((sh) => sh.type === "return" && Number.isFinite(sh.t)).map((sh) => sh.t),
    analysis.video?.width ?? 1920,
    analysis.video?.height ?? 1080,
    (l) => console.error(`[coaching] ${l}`)
  );

  await coachingProgress(supabase, analysisId, "Writing your practice session…");

  // A session the player can actually run, from what the analysis found.
  //
  // Text-only and last: the video has already been watched twice, everything
  // this needs is in `out`, and it costs a fraction of a cent. Wrapped like the
  // technique pass because a missing practice plan is a missing nice-to-have --
  // the read, the ratings and the drills are already written by now, and losing
  // those to a failure in the final optional step would be absurd.
  try {
    const planStartedAt = Date.now();
    const plan = await buildPracticePlan({
      model, analyst: out, drills: allDrills,
      onLog: (l) => console.error(`[coaching] ${l}`),
    });
    await recordCapture(supabase, {
      analysisId, pass: "practice_plan", model,
      config: { drillCatalogueSize: allDrills.length },
      output: plan,
      durationMs: Date.now() - planStartedAt,
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
  // Now, with the replacement in hand.
  await pruneStale();
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

  // EVERY CRITICISM GETS FOOTAGE, so every observation needs a moment.
  //
  // The model names one when it is talking about a shot. It does not when the
  // point is about a rally as a whole ("you stayed back through the whole
  // exchange"), and that used to mean the page fell back to the sentence this
  // whole feature exists to delete: "what happened at several points in the
  // clip". Several points is not evidence.
  //
  // So an observation with no moment borrows the MIDDLE OF ITS RALLY. Not the
  // start, which is a serve and looks the same in every rally, and not the
  // end, which is the point already being over. The middle is the exchange.
  //
  // Flagged as approximate, because it is: the page captions it as the rally
  // rather than as a cited instant, and that distinction is the difference
  // between showing your working and inventing it.
  const rallyMid = (idx: number | null): number | null => {
    if (idx === null) return null;
    const r = out.rallies.find((x) => x.idx === idx);
    if (!r || !Number.isFinite(r.start_s) || !Number.isFinite(r.end_s)) return null;
    const mid = (Number(r.start_s) + Number(r.end_s)) / 2;
    return Number.isFinite(mid) ? mid : null;
  };

  if (out.observations.length > 0) {
    const obsRows = out.observations.map((o) => {
      const named = Number.isFinite(Number(o.shot_t)) ? Number(o.shot_t) : null;
      const borrowed = named === null ? rallyMid(o.rally_idx) : null;
      return {
      analysis_id: analysisId,
      read_id: readId,
      rally_idx: o.rally_idx,
      t_s: named ?? borrowed,
      t_is_approx: named === null && borrowed !== null,
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
      };
    });
    const { data: inserted, error: insertObsError } = await supabase
      .from("coaching_observations").insert(obsRows).select("id, t_s, severity");
    if (insertObsError) throw insertObsError;

    // THE EVIDENCE. Every observation that names a moment gets the footage of
    // that moment, cut from the overlay the model read.
    //
    // After the insert rather than before it, and never throwing: the read is
    // already written and a failed cut must not lose it. An observation
    // without a clip is still a true observation -- it just cannot be checked,
    // and the UI shows it without a play control rather than with a broken one.
    const sourceKey = analysis.video?.storage_path ?? null;
    if (sourceKey && inserted && inserted.length > 0) {
      // THE PLAYER'S OWN FOOTAGE, fetched for the cuts.
      //
      // Downloaded here rather than reusing the pipeline's working copy
      // because coaching can run on its own, long after the vision pass that
      // had that copy has finished and cleaned up after itself. One download,
      // a dozen cuts off it, and it goes away again in the finally.
      const evTmp = await fsp.mkdtemp(path.join(os.tmpdir(), "pb-evsrc-"));
      const evSrc = path.join(evTmp, "source.mp4");
      try {
        await downloadToFile(sourceKey, evSrc);
        const clips = await cutEvidenceClips({
          analysisId,
          sourcePath: evSrc,
          clipSeconds: Number(analysis.video?.duration_seconds ?? 0),
          requests: (inserted as Array<{ id: string; t_s: number | null; severity: number }>)
            .filter((r) => r.t_s !== null)
            .map((r) => ({ id: r.id, tSeconds: Number(r.t_s), severity: r.severity })),
          onLog: (line) => console.error(`[coaching] ${line}`),
        });
        for (const c of clips) {
          const { error } = await supabase
            .from("coaching_observations")
            .update({ clip_path: c.path, clip_bucket: c.bucket })
            .eq("id", c.id);
          if (error) console.warn(`[coaching] clip path not recorded: ${describeError(error)}`);
        }
      } catch (err) {
        console.warn(`[coaching] evidence clips skipped: ${describeError(err)}`);
      } finally {
        await fsp.rm(evTmp, { recursive: true, force: true }).catch(() => {});
      }
    }
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
