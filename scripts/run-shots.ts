/**
 * Standalone shot-classification harness — runs the real vision pipeline
 * (court, players, pose, audio contacts, BALL + SHOTS) on a local video and
 * writes the result to disk. No Supabase involved, so you can iterate on
 * the ball model and the classifier thresholds against one clip quickly.
 *
 * Needs the same env as the app (.env.local is loaded): VISION_PROVIDER=
 * roboflow + ROBOFLOW_API_KEY for players, BALL_MODEL_ID for the ball.
 *
 * Usage:
 *   npx tsx scripts/run-shots.ts <video.mp4> [outDir]
 * Writes:
 *   <outDir>/shots.json      every classified shot with its features
 *   <outDir>/labels.csv      one row per shot for you to hand-label
 *                            (fill the `truth` column, then run eval-shots.ts)
 *   <outDir>/quality.json    pipeline quality + known limitations
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runVisionPipeline } from "../src/lib/vision/run-vision-pipeline";
import { SHOT_LABEL } from "../src/lib/vision/shots";

const execFileAsync = promisify(execFile);

async function loadEnvLocal() {
  try {
    const text = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
    for (const line of text.split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env.local — rely on the environment */
  }
}

async function probe(videoPath: string) {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", videoPath]);
  const raw = JSON.parse(stdout);
  const v = raw.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  return { durationSeconds: Number(raw.format.duration), width: v.width as number, height: v.height as number };
}

async function main() {
  await loadEnvLocal();
  const videoPath = process.argv[2];
  if (!videoPath) {
    console.error("usage: npx tsx scripts/run-shots.ts <video.mp4> [outDir]");
    process.exit(1);
  }
  const outDir = process.argv[3] ?? path.join(process.cwd(), "shot-results", path.basename(videoPath, path.extname(videoPath)));
  await fs.mkdir(outDir, { recursive: true });
  const visionFps = Number(process.env.VISION_FPS ?? "5");

  const meta = await probe(videoPath);
  const framesDir = await fs.mkdtemp(path.join(os.tmpdir(), "baseline-frames-"));
  await execFileAsync("ffmpeg", ["-y", "-i", videoPath, "-vf", `fps=${visionFps}`, "-q:v", "3", path.join(framesDir, "frame-%05d.jpg")]);
  const files = (await fs.readdir(framesDir)).filter((f) => f.endsWith(".jpg")).sort();
  const frames = files.map((f, i) => ({ path: path.join(framesDir, f), timestampSeconds: i / visionFps }));
  console.log(`${frames.length} frames at ${visionFps} fps · ${meta.width}x${meta.height} · ${meta.durationSeconds.toFixed(1)}s`);

  const t0 = Date.now();
  const result = await runVisionPipeline({
    videoPath,
    frames,
    frameWidthPx: meta.width,
    frameHeightPx: meta.height,
    visionFps,
    videoDurationSeconds: meta.durationSeconds,
  });
  console.log(`pipeline done in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${result.shots.length} shots, ball coverage ${result.quality.ballCoverage ?? "n/a"}`);

  await fs.writeFile(path.join(outDir, "shots.json"), JSON.stringify(result.shots, null, 2));
  await fs.writeFile(path.join(outDir, "quality.json"), JSON.stringify({ quality: result.quality, ball: result.ballTrack.stats, diagnostics: result.ballTrack.diagnostics }, null, 2));
  const csv = ["rally_idx,shot_idx,t_s,player,predicted,confidence,truth"]
    .concat(result.shots.map((s) => [s.rallyIdx, s.shotIdx, s.t, s.playerId ?? "", s.type, s.confidence, ""].join(",")))
    .join("\n");
  await fs.writeFile(path.join(outDir, "labels.csv"), csv);
  console.log(`wrote ${outDir}/shots.json, quality.json, labels.csv`);
  console.log("Known limitations:\n  " + result.quality.knownLimitations.join("\n  "));
  console.log(`\nLabel guide: ${Object.keys(SHOT_LABEL).join(" | ")}`);
  await fs.rm(framesDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
