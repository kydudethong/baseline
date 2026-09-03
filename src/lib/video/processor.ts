import type { VisionInput } from "@/lib/vision/types";
import { assertFfmpegAvailable, extractFrames, probeVideo, type ProbedMetadata } from "./ffmpeg";

export interface ValidationResult {
  valid: boolean;
  issues: string[];
}

/**
 * Server-side video processing, operating on a local file path (the caller
 * is responsible for getting the file onto local disk — e.g. downloading it
 * from Supabase Storage into a temp path first; see
 * src/lib/analysis/pipeline.ts).
 *
 *   VideoProcessor
 *   ├── getMetadata()      real ffprobe read
 *   ├── validateVideo()    sanity checks on the probed metadata
 *   ├── extractFrames()    real ffmpeg frame sampling
 *   └── prepareForVision() shapes frames + metadata into VisionProvider's input type
 *
 * Everything here is mechanical (ffmpeg/ffprobe), not AI — there is nothing
 * to mock. The CV and analysis layers downstream of this are what's mocked
 * in Phase 1.
 */
export class VideoProcessor {
  constructor(private readonly filePath: string) {}

  async getMetadata(): Promise<ProbedMetadata> {
    await assertFfmpegAvailable();
    return probeVideo(this.filePath);
  }

  validateVideo(metadata: ProbedMetadata): ValidationResult {
    const issues: string[] = [];

    if (!metadata.durationSeconds || metadata.durationSeconds < 3) {
      issues.push("Video is too short to analyze (under 3 seconds, or duration unreadable).");
    }
    if (!metadata.width || !metadata.height) {
      issues.push("Could not read video dimensions — the file may be corrupt.");
    } else if (metadata.height < 360) {
      issues.push(
        `Resolution is ${metadata.width}x${metadata.height}, which is too low for reliable player/ball tracking.`
      );
    }

    return { valid: issues.length === 0, issues };
  }

  async extractFrames(
    metadata: ProbedMetadata,
    outputDir: string,
    count = 6
  ): Promise<Array<{ path: string; timestampSeconds: number }>> {
    if (!metadata.durationSeconds) return [];
    return extractFrames(this.filePath, outputDir, {
      count,
      durationSeconds: metadata.durationSeconds,
    });
  }

  /** Shapes probed metadata + sampled frames into what a VisionProvider expects. */
  prepareForVision(
    metadata: ProbedMetadata,
    frames: Array<{ path: string; timestampSeconds: number }>
  ): VisionInput {
    return {
      videoDurationSeconds: metadata.durationSeconds ?? 0,
      width: metadata.width,
      height: metadata.height,
      frames,
    };
  }
}
