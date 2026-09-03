import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { getAnalysisForUser, updateAnalysisStatus, updateVideoMetadata } from "@/lib/db/analyses";
import { VideoProcessor } from "@/lib/video/processor";
import { getVisionProvider } from "@/lib/vision";
import type { VisionAnalysis } from "@/lib/vision/types";
import { getAnalysisEngine } from "@/lib/analysis";

const FRAME_SAMPLE_COUNT = 6;

/**
 * Runs the full (currently: metadata + mock CV + mock analysis) pipeline for
 * one analysis, moving it through the state machine and persisting results
 * as it goes. Intentionally synchronous/in-request for Phase 1 — see
 * README.md "What is intentionally not implemented yet" for why a real job
 * queue is a later-phase concern, not a Phase-1 one.
 */
export async function runPipeline(
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

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pb-analyzer-"));
    // Temp-dir path is only known at runtime (os.tmpdir() + mkdtemp), which
    // Turbopack's static analysis can't scope — tell it not to trace the
    // whole project on account of it. See the file's module doc comment.
    const localPath = path.join(
      /* turbopackIgnore: true */ tempDir,
      video.original_filename.replace(/[^\w.-]/g, "_")
    );
    await downloadToFile(supabase, video.storage_bucket, video.storage_path, localPath);

    const processor = new VideoProcessor(localPath);
    const metadata = await processor.getMetadata();

    const validation = processor.validateVideo(metadata);
    if (!validation.valid) {
      await updateAnalysisStatus(supabase, analysisId, "failed", {
        errorMessage: validation.issues.join(" "),
      });
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

    const frames = await processor.extractFrames(metadata, tempDir, FRAME_SAMPLE_COUNT);
    const visionInput = processor.prepareForVision(metadata, frames);

    const visionProvider = getVisionProvider();
    const perFrame = await visionProvider.detectObjects(visionInput);
    const tracks = await visionProvider.trackObjects(perFrame);
    const visionAnalysis: VisionAnalysis = { source: visionProvider.name, perFrame, tracks };

    const engine = getAnalysisEngine();
    const result = await engine.analyze(visionAnalysis, {
      title: analysis.title,
      durationSeconds: metadata.durationSeconds,
    });

    await updateAnalysisStatus(supabase, analysisId, "completed", { result });
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
