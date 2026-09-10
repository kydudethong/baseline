/**
 * Standalone shot-classification harness — runs the real vision pipeline
 * (court, players, pose, ball-movement contacts, BALL + SHOTS) on a local
 * video and writes the result to disk. No Supabase involved, so you can
 * iterate on the ball model and the classifier thresholds against one
 * clip quickly.
 *
 * Needs the same env as the app (.env.local is loaded): VISION_PROVIDER=
 * roboflow + ROBOFLOW_API_KEY for players, BALL_MODEL_ID for the ball.
 *
 * Usage:
 *   npx tsx scripts/run-shots.ts <video.mp4> [outDir] [--self <who>]
 *
 * --self says which tracked player the overlay should mark as YOU. Without it
 * nothing is marked, which is what every run of this harness did until a VLM
 * watching the overlay noticed there was no gold box anywhere in it. Two
 * forms:
 *
 *   --self player_2      name a track. Ids are assigned in order of first
 *                        appearance, so they are stable across identical
 *                        re-runs of the same clip but NOT across clips.
 *   --self 0.42,0.88     where that player's feet are, as a fraction of the
 *                        frame, optionally with @seconds (0.42,0.88@12.5).
 *                        Goes through the same seed-matching the app uses,
 *                        so it survives ids changing.
 * Writes:
 *   <outDir>/shots.json      every classified shot with its features
 *   <outDir>/labels.csv      one row per shot for you to hand-label
 *                            (fill the `truth` column, then run eval-shots.ts)
 *   <outDir>/quality.json    pipeline quality + known limitations
 *   <outDir>/ball.json       the ball track, ball-derived contacts and
 *                            calibration — everything needed to re-run the
 *                            classifier offline while tuning it
 *   <outDir>/rallies.json    the rally boundaries the run actually settled on,
 *                            AFTER keep-alive and the bounce rule. Written
 *                            because they were previously nowhere: the log
 *                            prints the crossing-derived spans BEFORE those
 *                            adjustments, shots.json only implies a rally's
 *                            extent from its first and last shot, and the
 *                            numbers that decided the analysis were not saved
 *                            at all. Anything comparing a segmenter against
 *                            another needs the actual answer, not two proxies
 *                            for it.
 *   <outDir>/tracks.json     player tracks
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
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

/** `--self` as either a track id or an `x,y[@t]` seed. */
function parseSelf(raw: string | undefined): { id?: string; seed?: { x: number; y: number; t: number } } {
  if (!raw) return {};
  const m = /^([0-9]*\.?[0-9]+)\s*,\s*([0-9]*\.?[0-9]+)(?:@([0-9]*\.?[0-9]+))?$/.exec(raw.trim());
  if (!m) return { id: raw.trim() };
  const x = Number(m[1]), y = Number(m[2]);
  // Fractions of the frame, not pixels. A "0.42" that meant 0.42 PIXELS would
  // silently seed the top-left corner and match whichever player happened to
  // be furthest from the camera.
  if (x > 1 || y > 1) {
    console.error(`--self ${raw}: x and y are fractions of the frame (0-1), not pixels`);
    process.exit(1);
  }
  // NaN, not 0, when no time is given. Zero is the worst possible default
  // here: matchTracksToSetup looks within 2s of the stated moment, and at
  // t=0 a clip usually shows people walking on court or nobody at all, so
  // the seed matches nothing and the run silently has no subject again.
  // The caller fills this in with something in the middle of the clip.
  return { seed: { x, y, t: m[3] === undefined ? Number.NaN : Number(m[3]) } };
}

async function main() {
  await loadEnvLocal();
  const argv = process.argv.slice(2);
  const selfAt = argv.indexOf("--self");
  const selfRaw = selfAt >= 0 ? argv[selfAt + 1] : undefined;
  const positional = argv.filter((_, i) => selfAt < 0 || (i !== selfAt && i !== selfAt + 1));
  const videoPath = positional[0];
  if (!videoPath) {
    console.error("usage: npx tsx scripts/run-shots.ts <video.mp4> [outDir] [--self player_2|0.42,0.88[@12.5]]");
    process.exit(1);
  }
  const self = parseSelf(selfRaw);
  if (self.seed && !Number.isFinite(self.seed.t)) {
    console.log("--self has no @seconds, so the position is read at the middle of the clip. "
      + "If nobody is standing there then, add @<seconds> from a moment mid-rally.");
  }
  const outDir = positional[1] ?? path.join(process.cwd(), "shot-results", path.basename(videoPath, path.extname(videoPath)));
  await fs.mkdir(outDir, { recursive: true });
  const visionFps = Number(process.env.VISION_FPS ?? "5");

  const meta = await probe(videoPath);
  const framesDir = await fs.mkdtemp(path.join(os.tmpdir(), "baseline-frames-"));
  // Cap player/court-detection frames at 1280px long edge regardless of
  // source resolution -- ball detection reads the source video directly
  // (detect_ball.py) and is unaffected, so a 4K source still gives it full
  // detail while this step uploads the same amount of data as a 720p clip
  // would. See src/lib/video/ffmpeg.ts's extractFrames for the app path.
  const maxDimension = Number(process.env.VISION_FRAME_MAX_DIMENSION ?? "1280");
  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-vf",
    `fps=${visionFps},scale='min(${maxDimension},iw)':-2`,
    "-q:v",
    "3",
    path.join(framesDir, "frame-%05d.jpg"),
  ]);
  const files = (await fs.readdir(framesDir)).filter((f) => f.endsWith(".jpg")).sort();
  const frames = files.map((f, i) => ({ path: path.join(framesDir, f), timestampSeconds: i / visionFps }));
  console.log(`${frames.length} frames at ${visionFps} fps · ${meta.width}x${meta.height} · ${meta.durationSeconds.toFixed(1)}s`);

  const t0 = Date.now();
  // debugId and tempDir are what switch on the two things this harness was
  // silently missing. Without a debugId the overlay is skipped even with
  // RALLY_SEG_DEBUG=1 -- the render is guarded on having a name to file it
  // under -- so the flag appeared to do nothing. Without a tempDir the pose
  // bursts around each contact are skipped, which is the "no scratch
  // directory was available" limitation in the output.
  //
  // Both are derived from the output directory, so re-running into the same
  // folder overwrites the same overlay rather than filling the debug folder
  // with a copy per run.
  const debugId = path.basename(path.resolve(outDir)).replace(/[^\w.-]/g, "_");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pb-run-shots-"));

  const result = await runVisionPipeline({
    videoPath,
    frames,
    frameWidthPx: meta.width,
    frameHeightPx: meta.height,
    visionFps,
    videoDurationSeconds: meta.durationSeconds,
    debugId,
    tempDir,
    selfPlayerId: self.id ?? null,
    // The seed form goes through matchTracksToSetup, the same path the app
    // uses when someone clicks themselves on the setup screen -- so this
    // exercises that code rather than a parallel one that could drift from it.
    setup: self.seed
      ? {
          frameTimestampSeconds: Number.isFinite(self.seed.t)
            ? self.seed.t
            : meta.durationSeconds / 2,
          frameWidthPx: meta.width,
          frameHeightPx: meta.height,
          court: null,
          players: [{ x: self.seed.x * meta.width, y: self.seed.y * meta.height, isSelf: true }],
          lineColorHex: null,
          matchMode: "doubles",
          savedAt: new Date().toISOString(),
        }
      : null,
  });
  const overlay = path.join(process.cwd(), "public", "rally-debug", `${debugId}.mp4`);
  if (existsSync(overlay)) console.log(`debug overlay: ${overlay}`);
  else if (process.env.RALLY_SEG_DEBUG) console.log("RALLY_SEG_DEBUG was set but no overlay was written — see the log above for why");

  console.log(`pipeline done in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${result.shots.length} shots, ball coverage ${result.quality.ballCoverage ?? "n/a"}`);

  // Who is on court, and how much each of them hit. Printed every run because
  // picking a subject means knowing the options, and the alternative was
  // reading ids off the overlay by eye.
  if (result.tracks.length) {
    const shotsBy = new Map<string, number>();
    for (const s of result.shots) {
      if (s.playerId) shotsBy.set(s.playerId, (shotsBy.get(s.playerId) ?? 0) + 1);
    }
    console.log(`tracked players (pass one to --self on the next run):`);
    for (const t of result.tracks) {
      const feet = t.points.length
        ? `x≈${(t.points.reduce((n, p) => n + p.boxImageNorm.x + p.boxImageNorm.width / 2, 0) / t.points.length).toFixed(2)}`
        : "no points";
      console.log(`  ${t.playerId.padEnd(10)} ${String(shotsBy.get(t.playerId) ?? 0).padStart(3)} shots  ${feet}`);
    }
    if (!self.id && !self.seed) console.log("  (none marked as YOU — the overlay will have no gold box)");
  }

  await fs.writeFile(path.join(outDir, "shots.json"), JSON.stringify(result.shots, null, 2));
  await fs.writeFile(path.join(outDir, "quality.json"), JSON.stringify({ quality: result.quality, ball: result.ballTrack.stats, diagnostics: result.ballTrack.diagnostics, calibration: result.courtCalibration }, null, 2));
  await fs.writeFile(
    path.join(outDir, "ball.json"),
    JSON.stringify({
      calibration: result.courtCalibration,
      frameWidthPx: meta.width,
      frameHeightPx: meta.height,
      // Rally windows come from player motion alone; these are the ball-
      // track-derived contact timestamps (ball.ts's detectHits), kept for
      // per-rally grouping and for reclassify-shots.ts/eval-rallies.ts.
      contacts: result.events.filter((e) => e.type === "unknown_shot").map((e) => e.timestampSeconds),
      points: result.ballTrack.points,
      // Per-frame candidates before tracking -- lets buildBallTrack's gating
      // constants be re-tuned offline later against real data instead of
      // needing a fresh (paid) model run each time. See run-vision-pipeline.ts.
      rawDetections: result.ballTrack.rawDetections,
      // So reclassify-shots.ts can re-derive the same rally windows offline
      // without re-probing the source video.
      durationSeconds: meta.durationSeconds,
    })
  );
  await fs.writeFile(
    path.join(outDir, "rallies.json"),
    JSON.stringify(result.rallies.map((r) => ({
      idx: r.idx,
      startS: Math.round(r.startS * 100) / 100,
      endS: Math.round(r.endS * 100) / 100,
      source: r.source,
      endReason: r.endReason,
      contactCount: r.contactCount,
      crossingCount: r.crossingCount,
      // How much of endS was keep-alive rather than evidence. Rally 6 on
      // ky-720p was extended past a point that had already finished, so this
      // is the field that says which boundaries to distrust.
      extendedSeconds: r.extendedSeconds,
    })), null, 2)
  );
  await fs.writeFile(path.join(outDir, "tracks.json"), JSON.stringify(result.tracks));
  const csv = ["rally_idx,shot_idx,t_s,player,predicted,confidence,truth"]
    .concat(result.shots.map((s) => [s.rallyIdx, s.shotIdx, s.t, s.playerId ?? "", s.type, s.confidence, ""].join(",")))
    .join("\n");
  await fs.writeFile(path.join(outDir, "labels.csv"), csv);
  console.log(`wrote ${outDir}/shots.json, rallies.json, quality.json, labels.csv`);
  console.log("rally boundaries this run settled on:");
  for (const r of result.rallies) {
    const ext = r.extendedSeconds > 0 ? `  (+${r.extendedSeconds.toFixed(1)}s keep-alive)` : "";
    console.log(`  ${String(r.idx).padStart(2)}  ${r.startS.toFixed(1)}-${r.endS.toFixed(1)}s`
      + `  ${r.contactCount} contacts  ${r.endReason ?? "no reason recorded"}${ext}`);
  }
  console.log("Known limitations:\n  " + result.quality.knownLimitations.join("\n  "));
  console.log(`\nLabel guide: ${Object.keys(SHOT_LABEL).join(" | ")}`);
  await fs.rm(framesDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
