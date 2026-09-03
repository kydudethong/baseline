import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class FfmpegError extends Error {}

/**
 * Confirms ffmpeg/ffprobe are on PATH, with an error that tells a developer
 * exactly what to do rather than a raw ENOENT.
 */
export async function assertFfmpegAvailable(): Promise<void> {
  try {
    await execFileAsync("ffprobe", ["-version"]);
  } catch {
    throw new FfmpegError(
      "ffprobe was not found on PATH. Install ffmpeg (e.g. `apt install ffmpeg` or " +
        "`brew install ffmpeg`) — this app shells out to it for video metadata and framing."
    );
  }
}

export interface ProbedMetadata {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  raw: Record<string, unknown>;
}

/** Runs ffprobe against a local file and extracts the fields we care about. */
export async function probeVideo(filePath: string): Promise<ProbedMetadata> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);

  const raw = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }>;
  };

  const videoStream = raw.streams?.find((s) => s.codec_type === "video");

  return {
    durationSeconds: raw.format?.duration ? Number(raw.format.duration) : null,
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    fps: videoStream?.r_frame_rate ? parseFrameRate(videoStream.r_frame_rate) : null,
    codec: videoStream?.codec_name ?? null,
    raw: raw as Record<string, unknown>,
  };
}

function parseFrameRate(rFrameRate: string): number | null {
  const [num, den] = rFrameRate.split("/").map(Number);
  if (!den) return null;
  return Math.round((num / den) * 100) / 100;
}

/**
 * Extracts up to `count` JPEG frames, evenly spaced across the video, into
 * `outputDir`. Returns each frame's file path and timestamp.
 *
 * Uses a single fps-filtered decode pass rather than seeking to each
 * timestamp individually — for a Phase-2-sized frame count (VISION_FPS=5
 * over a couple of minutes is several hundred frames) a per-frame `-ss`
 * seek measurably dominates pipeline wall-clock time (minutes, in
 * benchmark-video testing) because ffmpeg re-opens/re-seeks the container
 * on every call; one pass through the video decodes it exactly once.
 */
export async function extractFrames(
  filePath: string,
  outputDir: string,
  opts: { count: number; durationSeconds: number }
): Promise<Array<{ path: string; timestampSeconds: number }>> {
  const { count, durationSeconds } = opts;
  if (count <= 0 || durationSeconds <= 0) return [];

  const fps = count / durationSeconds;
  const pattern = `${outputDir}/frame-%04d.jpg`;
  await execFileAsync(
    "ffmpeg",
    ["-y", "-i", filePath, "-vf", `fps=${fps}`, "-q:v", "3", pattern],
    { maxBuffer: 20 * 1024 * 1024 }
  );

  const fs = await import("node:fs/promises");
  const files = (await fs.readdir(outputDir)).filter((f) => f.startsWith("frame-") && f.endsWith(".jpg")).sort();
  return files.slice(0, count).map((f, i) => ({
    path: `${outputDir}/${f}`,
    timestampSeconds: Math.round((i / fps) * 100) / 100,
  }));
}
