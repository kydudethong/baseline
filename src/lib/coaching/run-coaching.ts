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
import { analystModel } from "./gemini";
import type { AnalystInput, AnalystOutput } from "./analyst";
import type { UploadedFile } from "./gemini";
import { buildPracticePlan } from "./practice-plan";
import { matchPlaystyles } from "./pro-playstyles";
import { shotRowsFromAnalyst } from "./shot-rows";
import { fillApproachTimes } from "./approach-times";
import { activeWindows } from "./active-windows";
import { gatingEnabled } from "./read-rate";
import { recordCapture } from "./capture";
import { readOverlayBytes, OverlayMissingError } from "./overlay-source";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { downloadToFile } from "@/lib/storage/r2";
import { getSetup, matchTracksToSetup } from "@/lib/db/setup";
import { cutEvidenceClips } from "./evidence-clips";
import { OVERLAY_LEGEND } from "./overlay-legend";
import { buildReferenceFrameImage } from "./reference-frame-image";
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

/**
 * The analysis row as this pipeline needs it: with the video attached.
 *
 * Named because two functions take it now. The width and height are not
 * incidental -- the approach-time pass re-derives court positions from the raw
 * tracks, and that projection is in pixels before it is in feet.
 */
export type AnalysisWithVideo = AnalysisRow & {
  video: {
    duration_seconds: number | null; storage_path: string | null;
    width: number | null; height: number | null;
  } | null;
};

/**
 * Everything the analyst needs about a clip, loaded from the database.
 *
 * PULLED OUT FOR THE OVERNIGHT PATH, which finishes a run hours later in a
 * process holding nothing but an analysis id. It rebuilds these inputs rather
 * than unpacking a snapshot taken at submit time: a snapshot is a copy of the
 * pipeline's inputs that can go stale, arrive partial, or have been written by
 * a version of the code that no longer exists. The rows are the truth, and
 * reading them again costs a few queries.
 *
 * The live path calls it too, so there is one definition of "what the analyst
 * was told" instead of two that can drift.
 */
export interface AnalystContext {
  analysis: AnalysisWithVideo;
  analystInput: AnalystInput;
  allDrills: CoachingDrillRow[];
  shots: AnalysisShotRow[];
  model: string;
  /** Kept for the live path, which still needs the raw tracks for the gate. */
  tracksRes: { data: Array<{ points: unknown }> | null };
  profile: { skill_level: string | null } | null;
  /** Track label of the user's partner, resolved from the setup seeds. */
  partnerPlayerId: string | null;
}

export async function rebuildAnalystContext(
  supabase: Client,
  /**
   * BY ID ALONE, deliberately. This used to filter on user_id too, which the
   * collector cannot supply -- it is a scheduler acting on a row it found, not
   * a person. Ownership is now checked by the caller that HAS a user, one line
   * after this returns, so the check did not move out of the live path; it
   * moved to where the user actually is.
   */
  analysisId: string
): Promise<AnalystContext> {
  const { data: analysisData, error: analysisError } = await supabase
    .from("analyses")
    // The video row comes too: the analyst needs the clip's real length to
    // bound every timestamp it reports, and a wrong length there is how a
    // rally lands after the end of the footage.
    .select("*, video:videos(*)")
    .eq("id", analysisId)
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
    // From the ANALYSIS's owner, not from a caller-supplied id: the collector
    // acts on a row it found and has no user of its own.
    .eq("id", analysis.user_id)
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

  // ONE call, over the overlay video plus what was measured.
  //
  // This replaced a coaching read and a separate tagging pass over the same
  // facts plus that read -- two calls arranged so they could not contradict
  // each other. A single call cannot contradict itself, and the rallies and
  // ratings now come from the same reading of the same video as the prose
  // about them.
  /*
   * WHO THE PARTNER IS, RESOLVED FROM THE SETUP RATHER THAN A COLUMN.
   *
   * The user taps their partner on the setup frame, which stores a POINT, not
   * a track label -- tracks do not exist yet when they tap. Resolving it here,
   * from the setup row and the tracks that now do exist, means one answer for
   * both callers: the run that follows processing, and a re-run triggered from
   * the tag picker days later. A column would have needed a migration and
   * would have gone stale the moment the clip was re-analysed and the tracker
   * handed out different labels.
   *
   * NOT FOLDED INTO self_player_label. Several self labels already mean one
   * specific thing -- facts.ts merges them as fragments of the same person
   * after the tracker loses them behind an opponent -- so a partner in that
   * list would have half their shots counted as the user's.
   */
  let partnerPlayerId: string | null = null;
  try {
    const setup = await getSetup(supabase, analysisId);
    if (setup) {
      partnerPlayerId = matchTracksToSetup(
        ((tracksRes.data ?? []) as PlayerTrackRow[]).map((t) => ({
          playerId: t.player_label,
          points: ((t.points as Array<{
            timestampSeconds: number;
            boxImageNorm: { x: number; y: number; width: number; height: number };
          }> | null) ?? []).filter((pt) => pt.boxImageNorm),
        })),
        setup
      ).partnerPlayerId;
    }
  } catch {
    // A partnership read is an extra section, not the read. Losing it to an
    // unreadable setup row must not cost somebody their coaching.
    partnerPlayerId = null;
  }

  const analystInput = buildAnalystInput({
    clipSeconds: Number(analysis.video?.duration_seconds ?? 0),
    subjectPlayerId: analysis.self_player_label ?? null,
    partnerPlayerId,
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

  return {
    analysis, analystInput, allDrills,
    shots: (shotsRes.data ?? []) as AnalysisShotRow[],
    model: analystModel(),
    tracksRes,
    profile: profile ?? null,
    partnerPlayerId,
  };
}

export async function runCoachingPipeline(supabase: Client, userId: string, analysisId: string): Promise<void> {
  const ctx = await rebuildAnalystContext(supabase, analysisId);
  const { analysis, analystInput, allDrills, shots, tracksRes } = ctx;
  if (analysis.user_id !== userId) throw new CoachingPipelineError("Analysis not found");


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
    // THE GATE IS OFF WHEN THE PASS IS CHEAP.
    //
    // Motion gating was built against a real problem: at 15fps and high
    // resolution a twenty-minute game cost about $5.80 to watch end to end,
    // roughly half of it people walking to fetch a ball, and halving that
    // mattered. At 10fps and low resolution the same game is about $1.00, so
    // the gate now saves around fifty cents -- and what it risks buying that
    // with is a missed rally.
    //
    // That is a bad trade in a way the cost figure understates. The gate reads
    // PLAYER MOVEMENT, and the one phase of pickleball where nobody moves is
    // the kitchen dink exchange, which is also where most points are decided.
    // Its failure mode is not "loses a bit of dead time", it is "loses the
    // rallies that matter most, silently".
    //
    // So it runs only when a pass is expensive enough to be worth the risk.
    // ANALYST_GATE=on forces it back on, ANALYST_GATE=off forces it off.
    // OFF BY DEFAULT NOW, and the reason is that its predicted failure mode
    // turned up in real footage: rallies missing from the read, and rallies
    // cut short. Both are exactly what this comment said would happen. A
    // kitchen exchange is four people planted at the line moving only their
    // hands, so the motion signal goes quiet in the middle of a point that is
    // very much still being played -- and whatever the gate skips, the model
    // never sees at all. No prompt can recover a rally that was not sent.
    //
    // What it costs to leave it off: the scan watches the whole clip, so a
    // twenty-minute game at 10fps and high resolution is roughly double what a
    // half-gated one cost. That is a few dollars a game against an analysis
    // that is missing points, and a missing point is not a degraded read, it
    // is a wrong one -- the rally count, the shot totals and every average are
    // all computed off what came back.
    //
    // ANALYST_GATE=on puts it back for anyone who would rather pay less and
    // accept the risk. It is worth revisiting if the windows ever get their
    // own evidence: the right fix is a gate that knows about hands as well as
    // feet, not a cheaper one.
    const useGate = gate.gated && gatingEnabled();

    console.error(
      !useGate && gate.gated
        ? "[coaching] watching the whole clip — motion gating is off by default "
          + "because it was cutting real rallies short (ANALYST_GATE=on to re-enable)"
        : useGate
          ? `[coaching] watching ${Math.round(gate.coverage * 100)}% of the clip — `
            + `${gate.windows.length} stretch(es) where players were actually moving`
          : "[coaching] watching the whole clip — the tracks gave no clear split between play and dead time"
    );

    await coachingProgress(supabase, analysisId, useGate
      ? `Watching the ${gate.windows.length} stretches where you were playing…`
      : "Watching the clip…");
    const scanStartedAt = Date.now();
    // The still that says who is being coached. Built here rather than inside
    // runAnalyst so a failure to build one is logged next to the tag it came
    // from, instead of surfacing three layers down as a prompt that quietly
    // stopped naming anybody.
    const referenceFrame = await buildReferenceFrameImage({
      supabase,
      analysisId,
      userId: analysis.user_id,
      selfPlayerLabel: analysis.self_player_label ?? null,
      partnerPlayerLabel: ctx.partnerPlayerId,
      setup: await getSetup(supabase, analysisId).catch(() => null),
      sourceKey: analysis.video?.storage_path ?? null,
      onLog: (line) => console.error(`[coaching] ${line}`),
    });
    analyst = await runAnalyst({
      videoBytes: overlay,
      videoName: `${analysisId}.mp4`,
      input: analystInput,
      legend: OVERLAY_LEGEND,
      referenceFrame,
      activeWindows: useGate ? gate.windows : undefined,
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
        gated: useGate,
        coverage: useGate ? gate.coverage : 1,
        windows: useGate ? gate.windows : null,
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

  await persistCoachingOutput({
    supabase, analysisId,
    analysis,
    out: analyst.output,
    model: analyst.model,
    problems: analyst.problems,
    analystInput,
    allDrills,
    shots,
    file: analyst.file,
  });
}

/**
 * Everything that happens once the model has answered.
 *
 * SPLIT OUT SO A RUN CAN BE FINISHED BY A DIFFERENT PROCESS THAN THE ONE THAT
 * STARTED IT. The live path calls this straight after runAnalyst, exactly as
 * before. The overnight path cannot: it submits a batch job and exits, and
 * hours later some other process -- after a deploy, after the machine has
 * slept -- finds the finished job and needs to do all of this with an answer
 * it did not ask for.
 *
 * The alternative was a second copy of this for the batch path, and a second
 * copy is how two paths quietly start producing different analyses from the
 * same footage. There is one writer.
 *
 * It takes what it needs rather than re-reading it: the caller has already
 * loaded the analysis, the drills and the facts to get this far, and a
 * re-fetch here would be a second set of rows that can disagree with the first.
 */
export async function persistCoachingOutput(opts: {
  supabase: Client;
  analysisId: string;
  analysis: AnalysisWithVideo;
  out: AnalystOutput;
  model: string;
  /** Grounding problems the audit found. Stored as the read's quality issues. */
  problems: string[];
  analystInput: AnalystInput;
  allDrills: CoachingDrillRow[];
  /** The clip's shot rows, already loaded by the caller. */
  shots: AnalysisShotRow[];
  /** The uploaded video, when this caller owns it. The batch path may not. */
  file?: UploadedFile | null;
}): Promise<void> {
  const {
    supabase, analysisId, analysis, out, model, problems, analystInput, allDrills, shots, file,
  } = opts;
  const validSlugs = new Set(allDrills.map((d: CoachingDrillRow) => d.slug));

  // Moved in here with the write it makes room for. It used to sit at the top
  // of the run, which is how re-tagging a player once deleted a clip's rallies
  // and put nothing back: the delete happened, the expensive half failed, and
  // the analysis reported "no rallies were found" over footage full of them.
  const pruneStale = async () => {
    for (const table of ["coaching_rallies", "coaching_skill_ratings"] as const) {
      const { error } = await supabase.from(table).delete().eq("analysis_id", analysisId);
      if (error) throw new Error(`clearing ${table}: ${describeError(error)}`);
    }
  };
  if (problems.length) {
    console.error(`[coaching] ${problems.length} grounding problem(s) in the analyst's answer`);
  }



  // THE TECHNIQUE PASS IS GONE. ONE PASS, AT 10FPS AND HIGH RESOLUTION.
  //
  // It existed to solve a problem the scan no longer has. The scan used to run
  // at 5fps and LOW -- enough to see a ball change direction against a paddle,
  // nowhere near enough to see the swing that did it -- so a second, narrow,
  // expensive pass re-watched the windows around the subject's own contacts at
  // 10fps and high. Splitting was right: it bought the detail for about a
  // sixth of the price of reading the whole match closely.
  //
  // The scan is now 10fps and high over the whole clip, which is exactly what
  // the burst pass was buying. Keeping it would mean uploading nothing new and
  // re-reading eleven seconds of already-read frames at identical settings, to
  // ask a question the first call was already in a position to answer.
  //
  // WHAT THIS COSTS, said plainly: nothing writes coaching_shot_technique any
  // more, so the paddle / shoulders / contact / feet breakdown beside each
  // evidence clip is empty. The clip itself still plays and the criticism
  // still carries its moment. If that breakdown is wanted back, the honest
  // place for it is the scan's own output -- it is watching those frames at
  // the right resolution already -- rather than a second call.
  if (file) await releaseAnalystFile(file);

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
          usable: problems.length === 0,
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
          issues: problems,
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
          // IN THE BLOB RATHER THAN A TABLE OF ITS OWN, because it is prose
          // about one analysis that nothing aggregates over time. The things
          // that DID get tables -- observations, skill ratings -- earned them
          // by being tracked across analyses for progress and weakness
          // ranking. A partnership read is read once, next to the rest of the
          // read, and a table for it would be a migration and five joins
          // bought with nothing.
          //
          // Absent, not null, when there is no tagged partner: readers already
          // treat a missing key as "no section", and null would have to be
          // special-cased in each of them.
          ...(out.partnership ? { partnership: out.partnership } : {}),
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
  const shotRows = shots;
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
  // So an observation with no moment borrows its RALLY -- the whole of it, and
  // this is the part that was wrong.
  //
  // IT USED TO BORROW THE MIDPOINT and cut the ordinary shot-length clip
  // around it: two seconds before, one and a half after. The reasoning was
  // that "the middle is the exchange", which is not true of a rally that goes
  // serve, return, drive, put-away -- and is not true at all when the rally
  // boundaries themselves are wrong. Reported from real footage: a criticism
  // about standing too tall DURING KITCHEN EXCHANGES came with a clip of a
  // player about to serve, who was never at the kitchen in it.
  //
  // That is not an approximate citation, it is a manufactured one. The
  // observation claimed nothing about that instant; the pipeline picked the
  // instant, cut four seconds around it, and put it under the sentence as
  // evidence. A reader who watches it and sees something else does not
  // conclude "this clip is approximate" -- they conclude the analysis is
  // wrong, and on that evidence they are right to.
  //
  // A rally-level claim gets rally-level evidence: the window is the whole
  // rally, start to end, captioned as the rally rather than as an instant. It
  // cannot contradict the sentence, because "here is the point I am talking
  // about" is exactly what the sentence is about.
  const rallyWindow = (idx: number | null): { start: number; end: number } | null => {
    if (idx === null) return null;
    const r = out.rallies.find((x) => x.idx === idx);
    if (!r || !Number.isFinite(r.start_s) || !Number.isFinite(r.end_s)) return null;
    const start = Number(r.start_s);
    const end = Number(r.end_s);
    return end > start ? { start, end } : null;
  };

  if (out.observations.length > 0) {
    const obsRows = out.observations.map((o) => {
      const named = Number.isFinite(Number(o.shot_t)) ? Number(o.shot_t) : null;
      const window = named === null ? rallyWindow(o.rally_idx) : null;
      return {
      analysis_id: analysisId,
      read_id: readId,
      rally_idx: o.rally_idx,
      // The rally's START when the moment was borrowed, so the footage plays
      // the point from the beginning rather than dropping the reader into the
      // middle of it. The end comes from the rally, via t_is_approx.
      t_s: named ?? window?.start ?? null,
      t_is_approx: named === null && window !== null,
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
      .from("coaching_observations").insert(obsRows).select("id, t_s, severity, rally_idx, t_is_approx");
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
          requests: (inserted as Array<{ id: string; t_s: number | null; severity: number; rally_idx: number | null; t_is_approx: boolean | null }>)
            .filter((r) => r.t_s !== null)
            .map((r) => ({
              id: r.id,
              tSeconds: Number(r.t_s),
              severity: r.severity,
              // A borrowed moment gets the whole point, not a shot-length
              // window around an instant nobody claimed.
              endSeconds: r.t_is_approx ? rallyWindow(r.rally_idx)?.end : undefined,
            })),
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

  // SAY WHEN THERE ARE NONE. An empty skills array satisfies the schema, so a
  // run that rated nothing looked exactly like a run that rated everything
  // until you noticed the chart was missing from the page -- and "why can I
  // not see my skill ratings" was unanswerable from the logs.
  if (out.skills.length === 0) {
    console.error(
      "[coaching] no skill ratings returned — the ratings chart will be absent from the page. "
      + "The model is asked to omit a skill rather than invent a number, so this is what a clip "
      + "it could not judge looks like"
    );
  }
  if (out.skills.length > 0) {
    console.error(`[coaching] ${out.skills.length} skill rating(s): `
      + out.skills.map((sk) => `${sk.skill_key}=${sk.rating}`).join(", "));
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
