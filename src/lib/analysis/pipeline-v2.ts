import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { getAnalysisForUser, updateAnalysisStatus, updateVideoMetadata } from "@/lib/db/analyses";
import { VideoProcessor } from "@/lib/video/processor";
import { runVisionPipeline } from "@/lib/vision/run-vision-pipeline";

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
  const analysis = await getAnalysisForUser(supabase, userId, analysisId);
  if (!analysis) throw new Error("Analysis not found");
  const video = analysis.video;
  if (!video) throw new Error("No video attached to this analysis yet");

  let tempDir: string | null = null;

  try {
    await updateAnalysisStatus(supabase, analysisId, "queued");
    await updateAnalysisStatus(supabase, analysisId, "processing");

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pb-analyzer-v2-"));
    const localPath = path.join(
      /* turbopackIgnore: true */ tempDir,
      video.original_filename.replace(/[^\w.-]/g, "_")
    );
    await downloadToFile(supabase, video.storage_bucket, video.storage_path, localPath);

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
    const frames = await processor.extractFrames(metadata, tempDir, frameCount);

    const result = await runVisionPipeline({
      videoPath: localPath,
      frames,
      frameWidthPx: metadata.width ?? 0,
      frameHeightPx: metadata.height ?? 0,
      visionFps: VISION_FPS,
      videoDurationSeconds: metadata.durationSeconds ?? 0,
    });

    await persistVisionResult(supabase, userId, analysisId, result);

    await updateAnalysisStatus(supabase, analysisId, "completed", {
      result: {
        source: result.providerName === "mock" ? "mock" : "roboflow+llm",
        generatedAt: new Date().toISOString(),
        statistics: {
          tracksProduced: result.quality.tracksProduced,
          framesSampled: result.quality.framesSampled,
          courtCalibrationConfidence: result.quality.courtCalibrationConfidence,
          unknownShotEvents: result.quality.audioEventCount,
        },
        events: result.events.slice(0, 20).map((e) => ({
          type: e.type,
          timestampSeconds: e.timestampSeconds,
          description:
            e.type === "unknown_shot"
              ? "Paddle contact detected from audio — shot type not classified (out of scope for this phase)."
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
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown processing error";
    await updateAnalysisStatus(supabase, analysisId, "failed", { errorMessage: message });
    throw err;
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// How many sampled frames get a persisted JPEG for the debug page. Deliberately
// sparse — persisting every VISION_FPS-sampled frame for every analysis would
// scale storage cost with VISION_FPS rather than with clip count, and the
// debug page's purpose (spot-checking detections look sane) doesn't need
// every frame, just an even spread across the clip.
const DEBUG_FRAME_SAMPLE_COUNT = 16;

async function persistVisionResult(
  supabase: SupabaseClient<Database>,
  userId: string,
  analysisId: string,
  result: Awaited<ReturnType<typeof runVisionPipeline>>
): Promise<void> {
  // court_calibrations — one row
  {
    const { error } = await supabase.from("court_calibrations").upsert({
      analysis_id: analysisId,
      method: result.courtCalibration.method,
      confidence: result.courtCalibration.confidence,
      corners_image_px: result.courtCalibration.cornersImagePx,
      frame_timestamp_s: result.courtCalibration.frameTimestampSeconds,
      diagnostics: result.courtCalibration.diagnostics,
    });
    if (error) throw error;
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
    if (error) throw error;
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
    if (error) throw error;
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
    const { error } = await supabase.from("player_keypoints").insert(rows);
    if (error) throw error;
  }

  // movement_metrics — one row per track, with footwork attached
  if (result.movement.length > 0) {
    const footworkByPlayer = new Map(result.footwork.map((f) => [f.playerId, f]));
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
    }));
    const { error } = await supabase.from("movement_metrics").upsert(rows, {
      onConflict: "analysis_id,player_label",
    });
    if (error) throw error;
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
    const { error } = await supabase.from("analysis_events").insert(rows);
    if (error) throw error;
  }
}

async function downloadToFile(
  supabase: SupabaseClient<Database>,
  bucket: string,
  storagePath: string,
  localPath: string
): Promise<void> {
  const { data, error } = await supabase.storage.from(bucket).download(storagePath);
  if (error || !data) {
    throw new Error(`Could not download video from storage: ${error?.message ?? "no data"}`);
  }
  const buffer = Buffer.from(await data.arrayBuffer());
  await fs.writeFile(localPath, buffer);
}
