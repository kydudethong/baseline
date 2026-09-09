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
/**
 * Frames inside specific time windows, at a chosen rate — for looking closely
 * at moments rather than sampling the whole clip evenly.
 *
 * Why this is separate from extractFrames(): a swing lasts about a third of a
 * second, so at the 5 fps the rest of the pipeline runs at, a contact is
 * covered by one or two frames and there is no swing in the data to measure.
 * Sampling the WHOLE video fast enough to see a swing would be ~6x the pose
 * work for footage that is mostly players standing around. Bursts around the
 * contacts cost a fraction of that and put the frames where the information
 * is.
 *
 * Overlapping windows are merged first, so contacts a few tenths apart share
 * one decode instead of extracting the same frames twice. Each window is its
 * own ffmpeg call with input seeking (-ss before -i), which is a keyframe jump
 * rather than a decode of everything preceding it.
 */
export async function extractFrameWindows(
  filePath: string,
  outputDir: string,
  windows: Array<{ startSeconds: number; endSeconds: number }>,
  opts: { fps: number; maxDimension?: number }
): Promise<Array<{ path: string; timestampSeconds: number }>> {
  const { fps, maxDimension } = opts;
  if (fps <= 0 || windows.length === 0) return [];

  const sorted = windows
    .filter((w) => Number.isFinite(w.startSeconds) && Number.isFinite(w.endSeconds) && w.endSeconds > w.startSeconds)
    .map((w) => ({ startSeconds: Math.max(0, w.startSeconds), endSeconds: w.endSeconds }))
    .sort((a, b) => a.startSeconds - b.startSeconds);
  if (sorted.length === 0) return [];

  const merged: Array<{ startSeconds: number; endSeconds: number }> = [sorted[0]];
  for (const w of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (w.startSeconds <= last.endSeconds) last.endSeconds = Math.max(last.endSeconds, w.endSeconds);
    else merged.push({ ...w });
  }

  const fsp = await import("node:fs/promises");
  const vf = maxDimension ? `fps=${fps},scale='min(${maxDimension},iw)':-2` : `fps=${fps}`;
  const out: Array<{ path: string; timestampSeconds: number }> = [];

  for (let w = 0; w < merged.length; w++) {
    const win = merged[w];
    const dur = win.endSeconds - win.startSeconds;
    const prefix = `burst-${String(w).padStart(3, "0")}-`;
    await execFileAsync(
      "ffmpeg",
      ["-y", "-ss", win.startSeconds.toFixed(3), "-i", filePath, "-t", dur.toFixed(3),
       "-vf", vf, "-q:v", "3", `${outputDir}/${prefix}%04d.jpg`],
      { maxBuffer: 20 * 1024 * 1024 }
    );
    const files = (await fsp.readdir(outputDir))
      .filter((f) => f.startsWith(prefix) && f.endsWith(".jpg"))
      .sort();
    // ffmpeg's fps filter emits the first frame at the window start and then
    // one every 1/fps, so the index IS the offset. Deriving the timestamp
    // instead of parsing showinfo keeps this off stderr-format parsing.
    for (let i = 0; i < files.length; i++) {
      out.push({
        path: `${outputDir}/${files[i]}`,
        timestampSeconds: Math.round((win.startSeconds + i / fps) * 1000) / 1000,
      });
    }
  }
  return out;
}

export async function extractFrames(
  filePath: string,
  outputDir: string,
  opts: { count: number; durationSeconds: number; maxDimension?: number }
): Promise<Array<{ path: string; timestampSeconds: number }>> {
  const { count, durationSeconds, maxDimension } = opts;
  if (count <= 0 || durationSeconds <= 0) return [];

  const fps = count / durationSeconds;
  const pattern = `${outputDir}/frame-%04d.jpg`;
  // These frames feed player/court detection only -- ball detection reads
  // the source video directly (detect_ball.py / cv2.VideoCapture) and never
  // sees this resize, so a 4K source still gives the ball detector every
  // pixel it has. Player detection just needs to spot a person-sized box,
  // which a generic detector does fine well below source resolution -- so
  // capping the long edge here (maxDimension, e.g. 1280) means uploading a
  // 4K clip to the hosted API costs the same per-frame bandwidth/time as a
  // 720p one instead of ~9x more, with no accuracy trade-off for THIS step.
  // scale='min(N,iw)':-2 only shrinks when the source is actually larger.
  const vf = maxDimension ? `fps=${fps},scale='min(${maxDimension},iw)':-2` : `fps=${fps}`;
  await execFileAsync(
    "ffmpeg",
    ["-y", "-i", filePath, "-vf", vf, "-q:v", "3", pattern],
    { maxBuffer: 20 * 1024 * 1024 }
  );

  const fs = await import("node:fs/promises");
  const files = (await fs.readdir(outputDir)).filter((f) => f.startsWith("frame-") && f.endsWith(".jpg")).sort();
  return files.slice(0, count).map((f, i) => ({
    path: `${outputDir}/${f}`,
    timestampSeconds: Math.round((i / fps) * 100) / 100,
  }));
}
