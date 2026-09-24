import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { getSetup } from "@/lib/db/setup";
import { getAnalysisForUser, updateAnalysisStatus, updateVideoMetadata } from "@/lib/db/analyses";
import { VideoProcessor } from "@/lib/video/processor";
import { runVisionPipeline } from "@/lib/vision/run-vision-pipeline";
import { downloadToFile, uploadFileFromDisk, getSignedDownloadUrl } from "@/lib/storage/r2";
import { describeError } from "./describe-error";
import { StageTimer } from "./stage-timer";
import { runFinished, runStarted } from "./idle-sleep";
import {
  beginRun, clearActiveRunSignal, endRun, isCancellation, setActiveRunSignal,
} from "./run-registry";
import { LOCAL_BUCKET, R2_BUCKET, debugVideoDir, debugVideoKey, debugVideoObjectKey } from "@/lib/vision/debug-video-store";
import { isLocalDev } from "@/lib/deployment";
import type { AnalysisProgress, AnalysisStage } from "@/lib/db/types";
import { CoachingPipelineError, coachingProgress, runCoachingPipeline } from "@/lib/coaching/run-coaching";
import { readEmail } from "@/lib/notify/read-email";
import { sendEmail } from "@/lib/notify/send";
import { env } from "@/lib/env";
import { startHeartbeat } from "./heartbeat";
import { withRunSignal } from "./run-registry";
import { referenceFramePath } from "@/lib/coaching/reference-frame-image";

const VISION_FPS = Number(process.env.VISION_FPS ?? "5");

/**
 * Phase 2 pipeline: the real CV pipeline (court/players/tracking/pose/
 * movement/events — see run-vision-pipeline.ts) wired to persistence.
 *
 * Async-capable, dev-appropriate implementation: `kickOffPipelineV2` marks
 * the analysis "queued" synchronously, then does NOT await the actual run —
 * it lets the promise continue on the Node event loop after the HTTP
 * response returns. That's safe for a long-lived `next dev`/`next start`
 * Node process (which this app is deployed as — see README/PHASE1.md) but
 * NOT safe on a serverless platform that freezes the process after the
 * response is sent; a real production deploy would swap this for a durable
 * queue (Inngest, per architecture/phase-1-product-architecture.md) behind
 * the exact same runPipelineV2() call. That swap is intentionally NOT made
 * in this phase — see the deliverables report's "known limitations".
 */
export function kickOffPipelineV2(
  supabase: SupabaseClient<Database>,
  userId: string,
  analysisId: string
): void {
  runPipelineV2(supabase, userId, analysisId).catch((err) => {
    // runPipelineV2 already records failure to the DB; this catch only
    // stops an unhandled rejection from crashing the dev server.
    console.error(`[pipeline-v2] analysis ${analysisId} failed:`, err);
  });
}

export async function runPipelineV2(
  supabase: SupabaseClient<Database>,
  userId: string,
  analysisId: string
): Promise<void> {
  // Registered before anything can throw and released in the finally below,
  // so the idle watchdog can never stop this machine while a run is on the
  // event loop. A leaked increment would keep the machine awake for ever --
  // costly. A leaked decrement would let it sleep mid-analysis -- worse. The
  // try/finally is what makes neither possible.
  runStarted();
  // Registered so a cancel request can find this run, and published so every
  // Python subprocess it starts is spawned with the same signal -- which is
  // what makes "stop" mean seconds rather than "after the current four-minute
  // detector pass".
  const controller = beginRun(analysisId);
  setActiveRunSignal(controller.signal);
  // Everything that can fail must fail INSIDE the try, or the analysis is left
  // sitting at "uploaded" with no error while the client has already been told
  // processing started. These three throws used to happen outside it, and
  // kickOffPipelineV2's catch only console.errors -- a silent no-op.
  let tempDir: string | null = null;
  // Started here, beside runStarted() and beginRun(), because the three answer
  // the same question from different angles: is this run alive. The watchdog
  // asks it to decide whether to sleep the machine, the registry to decide
  // whether "stop" has anything to abort, and this so a READER can tell a run
  // that is working from one whose process no longer exists. Nothing else can
  // tell those apart -- every timeout in this codebase catches a hung process,
  // and none catches a dead one.
  const heartbeat = startHeartbeat(supabase, analysisId);

  // Everything below runs inside this run's own signal. setActiveRunSignal
  // stays as the fallback for any path that somehow escapes the store, but the
  // store is what makes two concurrent runs safe: without it, the second run
  // to start silently owns the signal that every LATER subprocess of the first
  // one is spawned with, and finishing the second kills the first.
  return withRunSignal(controller.signal, async () => {
  try {
    const analysis = await getAnalysisForUser(supabase, userId, analysisId);
    if (!analysis) throw new Error("Analysis not found");
    const video = analysis.video;
    if (!video) throw new Error("No video attached to this analysis yet");

    await updateAnalysisStatus(supabase, analysisId, "queued");
    await updateAnalysisStatus(supabase, analysisId, "processing");

    // Live stage, so a user who leaves and comes back is told what is
    // happening rather than watching an indeterminate bar for four minutes.
    //
    // Fire-and-forget, and deliberately so: a progress write that failed or was
    // slow must never hold up or take down the analysis it is describing. The
    // completed list is accumulated here rather than recomputed from the stage
    // order, because stages are genuinely skipped (no ball model, no audio) and
    // implying a skipped stage ran would be a small lie in a product whose
    // whole claim is that it does not tell them.
    const completedStages: AnalysisStage[] = [];
    let currentStage: AnalysisStage | null = null;
    let progressWritesFailed = false;
    const reportProgress = (stage: AnalysisStage, message: string) => {
      if (currentStage && currentStage !== stage && !completedStages.includes(currentStage)) {
        completedStages.push(currentStage);
      }
      currentStage = stage;
      const progress: AnalysisProgress = {
        stage, message, completedStages: [...completedStages], updatedAt: new Date().toISOString(),
      };
      if (progressWritesFailed) return;
      void supabase.from("analyses").update({ progress }).eq("id", analysisId)
        .then(({ error }) => {
          if (!error) return;
          // Report once, then stop trying. A missing column is not going to fix
          // itself mid-run, and a failed write per stage would bury the real
          // pipeline log under a dozen identical errors.
          progressWritesFailed = true;
          console.error(`[pipeline] progress not recorded (reporting once): ${describeError(error)}`);
        });
    };
    // Started here, not inside runVisionPipeline, so the download and the
    // frame extraction are in the same breakdown as the CV stages. Those two
    // are the parts most easily assumed to be free, which is exactly why they
    // need to be on the clock.
    const timer = new StageTimer();
    timer.mark("download");
    reportProgress("preparing", "Preparing the video");

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pb-analyzer-v2-"));
    const localPath = path.join(
      /* turbopackIgnore: true */ tempDir,
      video.original_filename.replace(/[^\w.-]/g, "_")
    );
    await downloadToFile(video.storage_path, localPath);

    const processor = new VideoProcessor(localPath);
    const metadata = await processor.getMetadata();
    const validation = processor.validateVideo(metadata);
    if (!validation.valid) {
      await updateAnalysisStatus(supabase, analysisId, "failed", { errorMessage: validation.issues.join(" ") });
      return;
    }

    await updateVideoMetadata(supabase, video.id, {
      duration_seconds: metadata.durationSeconds,
      width: metadata.width,
      height: metadata.height,
      fps: metadata.fps,
      codec: metadata.codec,
      probe_metadata: metadata.raw,
    });

    const frameCount = Math.max(1, Math.floor((metadata.durationSeconds ?? 0) * VISION_FPS));
    timer.mark("extract-frames");
    const frames = await processor.extractFrames(metadata, tempDir, frameCount);

    const result = await runVisionPipeline({
      videoPath: localPath,
      frames,
      frameWidthPx: metadata.width ?? 0,
      frameHeightPx: metadata.height ?? 0,
      visionFps: VISION_FPS,
      videoDurationSeconds: metadata.durationSeconds ?? 0,
      debugId: analysisId,
      setup: await getSetup(supabase, analysisId),
      tempDir,
      timer,
      onProgress: reportProgress,
    });

    await persistVisionResult(supabase, userId, analysisId, result);

    // The user already told us which player is them during setup, so there is
    // no reason to make them tag it again after the fact.
    //
    // Written unconditionally, including the null. Track labels are assigned
    // fresh on every run ("player_1", "player_2", ...), so a leftover tag of
    // "player_3" from a previous run names whoever happens to be third this
    // time -- and the coaching read is then written confidently about the
    // wrong person, with nothing anywhere reporting a problem.
    const { error: tagError } = await supabase
      .from("analyses")
      .update({ self_player_label: result.selfPlayerId })
      .eq("id", analysisId);
    if (tagError) throw new Error(`writing self_player_label: ${describeError(tagError)}`);

    // Record WHERE the overlay is, not a URL — every page resolves it through
    // debugVideoUrl(), so moving it is a change to this value and nothing else.
    //
    // It goes to R2 rather than staying on the box that rendered it. On Fly the
    // container has no volume: an overlay written to public/rally-debug is gone
    // at the next deploy, and a user who ticked the box to get one would find a
    // dead link days later with nothing explaining why. Locally there is no
    // bucket configured and no reason to pay for one, so it stays on disk.
    if (result.debugVideoUrl) {
      let key = debugVideoKey(analysisId);
      let bucket = LOCAL_BUCKET;
      const localPath = path.join(debugVideoDir(), debugVideoKey(analysisId));
      if (!isLocalDev()) {
        try {
          const objectKey = debugVideoObjectKey(analysisId);
          await uploadFileFromDisk(objectKey, localPath, "video/mp4");
          key = objectKey;
          bucket = R2_BUCKET;
          // The container copy has served its purpose and is ~35 MB. Failing to
          // remove it is untidy, not broken, so it does not stop anything.
          await fs.rm(localPath, { force: true }).catch(() => {});
        } catch (err) {
          // Keep the local copy and the local bucket. The overlay then works
          // until the next deploy, which is worse than R2 and much better than
          // recording a key that points at nothing.
          console.error(`[pipeline] overlay upload failed, leaving it on this machine: ${describeError(err)}`);
        }
      }
      const { error } = await supabase.from("analyses").update({
        debug_video_path: key,
        debug_video_bucket: bucket,
      }).eq("id", analysisId);
      if (error) console.error(`[pipeline] debug video location not recorded: ${describeError(error)}`);
    }

    reportProgress("saving", "Saving results");
    await updateAnalysisStatus(supabase, analysisId, "completed", {
      result: {
        source: result.providerName === "mock" ? "mock" : "roboflow+llm",
        generatedAt: new Date().toISOString(),
        statistics: {
          tracksProduced: result.quality.tracksProduced,
          framesSampled: result.quality.framesSampled,
          courtCalibrationConfidence: result.quality.courtCalibrationConfidence,
          unknownShotEvents: result.quality.shotEventCount,
        },
        events: result.events.slice(0, 20).map((e) => ({
          type: e.type,
          timestampSeconds: e.timestampSeconds,
          description:
            e.type === "unknown_shot"
              ? "Paddle contact detected from ball movement — shot type not classified (out of scope for this phase)."
              : `Candidate split-step for ${e.playerId} — a movement heuristic, not a verified technique judgment.`,
        })),
        insights: [
          `Court calibration confidence: ${result.quality.courtCalibrationConfidence}. ${
            result.quality.courtCalibrationConfidence === 0
              ? "Calibration failed — movement metrics could not be computed for this clip."
              : "Movement metrics below are approximate, derived from this calibration."
          }`,
          ...result.quality.knownLimitations,
        ],
        recommendations: [
          "Coaching analysis will be added after CV measurements are validated across more footage — see the debug page for this analysis's raw detections.",
        ],
      },
    });

    // Write the coaching read here rather than making the user ask for it.
    //
    // The self-tag step exists because the CV run has to finish before there
    // are tracks to tag -- but when setup was done, the user already pointed
    // at themselves before any of this started, and asking a second time is
    // asking a question we have the answer to. Without a tag we genuinely do
    // not know who to write about, so the picker still earns its place then.
    //
    // Deliberately after "completed": the CV results stand on their own, and a
    // coaching call that fails (no rallies to read, Claude unreachable, no API
    // key) must not turn a good run into a failed one. The button on the
    // analysis page remains the retry.
    if (result.selfPlayerId) {
      try {
        // SAID BEFORE IT STARTS. The analysis is already "completed" by this
        // point, and without a coaching stage on the row the page had no way
        // to tell a read being written from a read that never would be -- it
        // showed empty panels under a Completed badge for the several minutes
        // Gemini takes on a full game.
        await coachingProgress(supabase, analysisId, "Watching the game and writing your read…");
        await runCoachingPipeline(supabase, userId, analysisId);
        await coachingProgress(supabase, analysisId, "Coaching read finished.", { done: true });
        await notifyRead(supabase, userId, analysisId, "ready");
      } catch (err) {
        const why = err instanceof CoachingPipelineError
          ? err.message
          : describeError(err);
        console.warn(`[pipeline-v2] coaching read skipped for ${analysisId}: ${why}`);
        /*
         * RECORDED, NOT JUST LOGGED.
         *
         * This branch only wrote to the container's stdout, so a coaching pass
         * that failed left an analysis marked "completed" with every panel on
         * it empty and nothing anywhere saying why -- which reads as the
         * product being broken rather than one step of it having failed. The
         * reason was in Fly's logs, where the person looking at the blank page
         * cannot get at it.
         *
         * The manual re-run path has always recorded this, in
         * kickOffCoachingPipeline, into exactly this field: progress.error
         * exists because "a failed background run is indistinguishable from a
         * slow one". The automatic run simply never used it. Same slot, same
         * shape, so the page needs one renderer rather than two.
         */
        await coachingProgress(supabase, analysisId, "Coaching read failed.", { error: why });
        await notifyRead(supabase, userId, analysisId, "failed");
      }
    }
  } catch (err) {
    // A stop is not a failure, and must not be recorded as one. The video is
    // untouched and the analysis is exactly as re-runnable as it was before
    // the run started, so it goes back to "uploaded" -- the state it would
    // have been in had nobody pressed analyse.
    //
    // Deliberately NOT a new "cancelled" status: that needs an enum value in
    // the database, and code that writes a value the enum does not have fails
    // every cancel until the migration is run. Reverting works the moment it
    // ships.
    if (isCancellation(err)) {
      console.error(`[pipeline-v2] analysis ${analysisId} stopped by request`);
      await updateAnalysisStatus(supabase, analysisId, "uploaded", { errorMessage: null });
      return;
    }
    const message = describeError(err);
    console.error(`[pipeline-v2] analysis ${analysisId} failed: ${message}`, err);
    await updateAnalysisStatus(supabase, analysisId, "failed", { errorMessage: message });
    throw err;
  } finally {
    // Before anything else in here: once this returns, the row must stop
    // claiming to be alive. A heartbeat that outlived its run would be worse
    // than none, because it would vouch for a process that has exited.
    heartbeat.stop();
    runFinished();
    clearActiveRunSignal(controller.signal);
    endRun(analysisId, controller);
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  });
}

// How many sampled frames get a persisted JPEG for the debug page. Deliberately
// sparse — persisting every VISION_FPS-sampled frame for every analysis would
// scale storage cost with VISION_FPS rather than with clip count, and the
// debug page's purpose (spot-checking detections look sane) doesn't need
// every frame, just an even spread across the clip.
const DEBUG_FRAME_SAMPLE_COUNT = 16;

/**
 * Remove this analysis's previous results, so a re-run replaces them.
 *
 * Two of these tables are plain inserts with no unique key -- player_keypoints
 * and analysis_events -- which means every re-run was quietly appending a
 * second full copy of the poses and events beside the first. Nothing errored;
 * the numbers just doubled, which is worse, because a crash gets fixed and a
 * silently doubled dataset gets believed.
 *
 * Deleting before writing is not atomic: a run that fails halfway leaves this
 * analysis with nothing rather than with its old results. That is the right
 * trade here -- the old results are what the user is re-running to replace, and
 * a visible empty state is honest where a half-old, half-new mixture is not.
 */
async function clearPreviousResults(
  supabase: SupabaseClient<Database>,
  analysisId: string
): Promise<void> {
  const tables = [
    "analysis_events", "player_keypoints", "analysis_shots", "movement_metrics",
    "player_tracks", "analysis_frames", "ball_tracks", "court_calibrations",
    // New in 0009. Both must be cleared for the same reason as the rest: a
    // re-run that appended would leave two generations of rallies side by side,
    // and a silently doubled dataset gets believed.
    "analysis_rallies", "analysis_quality",
  ] as const;
  for (const table of tables) {
    const { error } = await supabase.from(table).delete().eq("analysis_id", analysisId);
    if (error) throw new Error(`clearing ${table}: ${describeError(error)}`);
  }
}

/**
 * Insert in chunks, because one statement per table stops scaling.
 *
 * Burst pose sampling around contacts multiplied player_keypoints several-fold
 * (a 90s 1080p clip went from ~1.8k rows to ~5.6k, each carrying a 17-point
 * JSON blob) and the single insert hit Postgres' statement_timeout, failing the
 * whole analysis after all the expensive work was done. Row count here is a
 * function of clip length and contact count, so any fixed batch is a ceiling
 * waiting to be hit; chunking removes the ceiling instead of raising it.
 *
 * Sequential rather than parallel: this is one connection through PostgREST,
 * and firing a dozen large inserts at once trades a timeout for a pool
 * exhaustion.
 */
async function insertInChunks(
  supabase: SupabaseClient<Database>,
  table: string,
  rows: object[],
  chunkSize = 500
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    /* eslint-disable @typescript-eslint/no-explicit-any --
       One generic helper over several tables. Each caller builds rows that are
       already correctly typed for its own table; erasing the type here only
       loosens the check inside this loop, not at the call sites. */
    const table_ = supabase.from(table as any) as any;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const { error } = await table_.insert(rows.slice(i, i + chunkSize));
    if (error) {
      throw new Error(
        `writing ${table} (rows ${i}-${Math.min(i + chunkSize, rows.length)} of ${rows.length}): ${describeError(error)}`
      );
    }
  }
}

async function persistVisionResult(
  supabase: SupabaseClient<Database>,
  userId: string,
  analysisId: string,
  result: Awaited<ReturnType<typeof runVisionPipeline>>
): Promise<void> {
  await clearPreviousResults(supabase, analysisId);

  // court_calibrations — one row
  {
    // onConflict is not optional here. Without it PostgREST resolves the
    // upsert against the primary key -- which is a `gen_random_uuid()` id, so
    // it never conflicts -- and the write becomes a plain insert that then
    // hits the unique constraint on analysis_id. First run fine, every re-run
    // dead. Every other upsert in this function names its constraint; this one
    // did not, and that asymmetry was the bug.
    const { error } = await supabase.from("court_calibrations").upsert({
      analysis_id: analysisId,
      method: result.courtCalibration.method,
      confidence: result.courtCalibration.confidence,
      corners_image_px: result.courtCalibration.cornersImagePx,
      frame_timestamp_s: result.courtCalibration.frameTimestampSeconds,
      diagnostics: result.courtCalibration.diagnostics,
    }, { onConflict: "analysis_id" });
    if (error) throw new Error(`writing court_calibrations: ${describeError(error)}`);
  }

  // analysis_frames — one row per sampled frame; a sparse subset also gets
  // its JPEG uploaded to Storage for the debug page (see DEBUG_FRAME_SAMPLE_COUNT).
  if (result.perFrameDetections.length > 0) {
    const total = result.perFrameDetections.length;
    const debugStep = Math.max(1, Math.floor(total / DEBUG_FRAME_SAMPLE_COUNT));

    const rows = await Promise.all(
      result.perFrameDetections.map(async (f, i) => {
        let debugStoragePath: string | null = null;
        if (i % debugStep === 0) {
          const fs = await import("node:fs/promises");
          try {
            const bytes = await fs.readFile(f.framePath);
            const storagePath = `${userId}/${analysisId}/debug/frame-${String(i).padStart(4, "0")}.jpg`;
            const { error: uploadError } = await supabase.storage
              .from("videos")
              .upload(storagePath, bytes, { contentType: "image/jpeg", upsert: true });
            if (!uploadError) {
              debugStoragePath = storagePath;
            } else {
              // Debug frame upload is best-effort — never fail the whole
              // pipeline over a missing thumbnail for the debug page. Still
              // log it: a silent failure here is exactly what let the
              // Storage MIME-type rejection (see migration 0004) go
              // unnoticed for an entire run.
              console.warn(`[pipeline-v2] debug frame upload rejected for frame ${i}:`, uploadError);
            }
          } catch (err) {
            console.warn(`[pipeline-v2] debug frame read/upload failed for frame ${i}:`, err);
          }
        }
        return {
          analysis_id: analysisId,
          timestamp_s: f.timestampSeconds,
          frame_index: i,
          player_count: f.players.length,
          debug_storage_path: debugStoragePath,
        };
      })
    );

    const { error } = await supabase.from("analysis_frames").upsert(rows, {
      onConflict: "analysis_id,frame_index",
    });
    if (error) throw new Error(`writing analysis_frames: ${describeError(error)}`);
  }

  // player_tracks — one row per track
  if (result.tracks.length > 0) {
    const rows = result.tracks.map((t) => ({
      analysis_id: analysisId,
      player_label: t.playerId,
      first_seen_s: t.points[0]?.timestampSeconds ?? 0,
      last_seen_s: t.points[t.points.length - 1]?.timestampSeconds ?? 0,
      point_count: t.points.length,
      points: t.points,
    }));
    const { error } = await supabase.from("player_tracks").upsert(rows, {
      onConflict: "analysis_id,player_label",
    });
    if (error) throw new Error(`writing player_tracks: ${describeError(error)}`);
  }

  // player_keypoints — one row per (player, frame) pose
  if (result.poses.length > 0) {
    const rows = result.poses.map((p) => ({
      analysis_id: analysisId,
      player_label: p.playerId,
      timestamp_s: p.timestampSeconds,
      detection_confidence: p.detectionConfidence,
      keypoints: p.keypoints,
      model_source: p.modelSource,
    }));
    // Smaller chunks than the default: each row carries a 17-point JSON blob,
    // so 300 of these is comparable in bytes to 500 of anything else here.
    await insertInChunks(supabase, "player_keypoints", rows, 300);
  }

  // movement_metrics — one row per track, with footwork attached
  if (result.movement.length > 0) {
    const footworkByPlayer = new Map(result.footwork.map((f) => [f.playerId, f]));
    const positioningByPlayer = new Map((result.positioning ?? []).map((p) => [p.playerId, p]));
    const rows = result.movement.map((m) => ({
      analysis_id: analysisId,
      player_label: m.playerId,
      distance_covered_court_units: m.distanceCoveredCourtUnits,
      distance_covered_meters_approx: m.distanceCoveredMetersApprox,
      average_speed_court_units_s: m.averageSpeedCourtUnitsPerSecond,
      max_speed_court_units_s: m.maxSpeedCourtUnitsPerSecond,
      court_coverage_bounds: m.courtCoverageBounds,
      transformed_sample_count: m.transformedSampleCount,
      total_sample_count: m.totalSampleCount,
      footwork: footworkByPlayer.get(m.playerId) ?? null,
      // 0017. Null when the court was not calibrated -- none of it is
      // computable without court coordinates, and a row of zeroes would read
      // as "this player never went to the kitchen" rather than "nobody looked".
      positioning: positioningByPlayer.get(m.playerId) ?? null,
    }));
    const { error } = await supabase.from("movement_metrics").upsert(rows, {
      onConflict: "analysis_id,player_label",
    });
    if (error) {
      // A MISSING OPTIONAL COLUMN MUST NOT FAIL THE WHOLE ANALYSIS.
      //
      // `positioning` arrived in 0017, and code ships before a migration is
      // run -- so there is always a window where the app writes a column the
      // database does not have yet. PostgREST answers PGRST204, and this
      // rethrew it, which killed a run that had already done every expensive
      // thing: the frames, the detection, the pose, the overlay. All of it
      // discarded because one nice-to-have column was missing.
      //
      // The same shape will recur with the next optional column, so the retry
      // is written to drop whatever the error names rather than `positioning`
      // specifically.
      const missing = missingColumnFrom(error);
      if (!missing) throw new Error(`writing movement_metrics: ${describeError(error)}`);

      console.error(`[pipeline] movement_metrics: this database has no "${missing}" column yet — `
        + "writing everything else and carrying on. Run the outstanding migration to store it.");
      const withoutMissing = rows.map((r) => {
        const copy = { ...r } as Record<string, unknown>;
        delete copy[missing];
        return copy as typeof r;
      });
      const retry = await supabase.from("movement_metrics").upsert(withoutMissing, {
        onConflict: "analysis_id,player_label",
      });
      if (retry.error) throw new Error(`writing movement_metrics: ${describeError(retry.error)}`);
    }
  }

  // ball_tracks + analysis_shots (cleared above, along with everything else)
  {
    if (result.ballTrack.stats) {
      const { error } = await supabase.from("ball_tracks").upsert(
        {
          analysis_id: analysisId,
          points: result.ballTrack.points,
          frames_processed: result.ballTrack.stats.framesProcessed,
          points_detected: result.ballTrack.stats.pointsDetected,
          points_interpolated: result.ballTrack.stats.pointsInterpolated,
          coverage: result.ballTrack.stats.coverage,
          diagnostics: result.ballTrack.diagnostics,
        },
        { onConflict: "analysis_id" }
      );
      if (error) throw new Error(`writing ball_tracks: ${describeError(error)}`);
    }
    if (result.shots.length > 0) {
      const rows = result.shots.map((s) => ({
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
        // Absent stays absent. A shot the burst never covered is written
        // WITHOUT this key rather than with an object of nulls, because a null
        // knee angle still reads as "we looked and it was nothing".
        ...(s.mechanics ? { mechanics: s.mechanics } : {}),
      }));
      await insertInChunks(supabase, "analysis_shots", rows);
    }
  }

  // analysis_rallies — the SEGMENTER's boundaries.
  //
  // Written here, in the same persist as the shots and from the same run, which
  // is what makes analysis_shots.rally_idx a valid key into this table. It is
  // not the same thing as coaching_rallies: that one is re-derived later by
  // re-clustering contact timestamps and disagrees on numbering and count.
  // Both exist; only this one is safe to join on.
  //
  // Both writes below are NON-FATAL. They are new metadata about a result, not
  // the result: an analysis whose shots, tracks and coaching all persisted
  // correctly must not be marked failed because a table added in 0009 is not
  // there yet. The failure is logged loudly and recorded as a known limitation
  // rather than swallowed -- silence here is how a missing table becomes a
  // mysteriously empty UI three weeks later.
  if (result.rallies.length > 0) {
    const rows = result.rallies.map((r) => ({
      analysis_id: analysisId,
      idx: r.idx,
      start_s: r.startS,
      end_s: r.endS,
      source: r.source,
      end_reason: r.endReason,
      contact_count: r.contactCount,
      crossing_count: r.crossingCount,
      extended_seconds: r.extendedSeconds,
      contacts: r.contacts,
    }));
    try {
      await insertInChunks(supabase, "analysis_rallies", rows);
    } catch (err) {
      console.error(`[pipeline] analysis_rallies not written: ${describeError(err)}`);
    }
  }

  // analysis_quality — what the pipeline knows about its own reliability.
  //
  // Until now four of these numbers survived into analyses.result.statistics
  // and the rest were computed and dropped. A UI that is meant to be honest
  // about confidence needs somewhere to read it from.
  {
    const q = result.quality;
    const { error } = await supabase.from("analysis_quality").upsert({
      analysis_id: analysisId,
      vision_fps: q.visionFps,
      video_duration_s: q.videoDurationSeconds,
      frames_sampled: q.framesSampled,
      players_per_frame: q.playersDetectedPerFrame,
      tracks_produced: q.tracksProduced,
      tracks_with_stable_id: q.tracksWithStableId,
      pose_frames_attempted: q.poseFramesAttempted,
      pose_frames_succeeded: q.poseFramesSucceeded,
      ball_coverage: q.ballCoverage,
      ball_frames_processed: result.ballTrack.stats?.framesProcessed ?? null,
      ball_points_detected: result.ballTrack.stats?.pointsDetected ?? null,
      ball_points_interpolated: result.ballTrack.stats?.pointsInterpolated ?? null,
      court_confidence: result.courtCalibration.confidence,
      court_method: result.courtCalibration.method,
      contacts_found: q.shotEventCount,
      shots_classified: q.shotsClassified,
      dead_ball_count: q.deadBallCount ?? null,
      rally_source: result.rallies[0]?.source ?? null,
      limitations: q.knownLimitations,
    }, { onConflict: "analysis_id" });
    if (error) console.error(`[pipeline] analysis_quality not written: ${describeError(error)}`);
  }

  // analysis_events
  if (result.events.length > 0) {
    const rows = result.events.map((e) => ({
      analysis_id: analysisId,
      event_type: e.type,
      timestamp_s: e.timestampSeconds,
      player_label: e.playerId,
      confidence: e.confidence,
      source: e.source,
    }));
    await insertInChunks(supabase, "analysis_events", rows);
  }
}

/**
 * The column name from a PostgREST "column not in the schema cache" error, or
 * null if that is not what this error is.
 *
 * PGRST204 is specifically "you sent a column I do not have", which for this
 * app almost always means a migration has not been run yet on a database the
 * new code is already talking to. Matching on the code AND extracting the name
 * keeps the recovery narrow: any other write failure is still a real failure.
 */
function missingColumnFrom(error: unknown): string | null {
  const e = error as { code?: unknown; message?: unknown };
  if (e?.code !== "PGRST204") return null;
  const message = typeof e.message === "string" ? e.message : "";
  return /'([^']+)' column/.exec(message)?.[1] ?? null;
}


/**
 * Email the owner that their read is ready, or that it did not finish.
 *
 * Only from THIS path, the automatic run after processing. The manual re-run
 * is started by somebody sitting on the page watching it, and emailing them
 * about a thing on their screen is noise.
 *
 * Never throws: the read is on the page whether or not the email went.
 */
async function notifyRead(
  supabase: SupabaseClient<Database>,
  userId: string,
  analysisId: string,
  kind: "ready" | "failed"
): Promise<void> {
  try {
    // The service-role client is what runs this pipeline, and it is the only
    // one that can look a user's email up by id.
    const { data: userRes } = await supabase.auth.admin.getUserById(userId);
    const to = userRes?.user?.email;
    if (!to) return;
    const [{ data: analysis }, { data: read }] = await Promise.all([
      supabase.from("analyses").select("title").eq("id", analysisId).maybeSingle(),
      supabase.from("coaching_reads").select("headline").eq("analysis_id", analysisId).maybeSingle(),
    ]);
    // The marked still, signed for a week. Best-effort in every direction:
    // an unsigned or missing frame costs the picture, not the email.
    let imageUrl: string | null = null;
    if (kind === "ready") {
      imageUrl = await getSignedDownloadUrl(referenceFramePath(userId, analysisId), 7 * 24 * 3600)
        .catch(() => null);
    }
    const content = readEmail({
      kind,
      title: (analysis as { title?: string } | null)?.title ?? "your game",
      headline: kind === "ready" ? ((read as { headline?: string | null } | null)?.headline ?? null) : null,
      url: `${env.siteUrl.replace(/\/+$/, "")}/dashboard/${analysisId}`,
      imageUrl,
    });
    const sent = await sendEmail(to, content);
    if (sent) console.log(`[email] read-${kind} sent for ${analysisId}`);
  } catch (err) {
    console.warn(`[email] could not notify for ${analysisId}: ${describeError(err)}`);
  }
}
