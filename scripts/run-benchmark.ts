/**
 * Standalone benchmark harness — NOT part of the Next.js app. Runs the real
 * Phase 2 CV pipeline (court detection, tracking, pose, movement, audio
 * events) against the actual benchmark video and dumps results to disk for
 * inspection, without touching Supabase (this dev sandbox has no network
 * path to supabase.co — see the deliverables report).
 *
 * Player detection stand-in: this environment also has no network path to
 * roboflow.com, so detectPlayers() here is NOT RoboflowPhase2VisionProvider
 * — it reuses the local YOLOv8n-pose model's own person-class boxes (pose
 * estimation necessarily detects people first) as a stand-in detector, so
 * everything else in the pipeline (tracking, homography, movement,
 * pose-to-track linking, events) can be exercised against real video
 * content end-to-end. This is clearly NOT a test of Roboflow's hosted API
 * itself — that call is written to Roboflow's documented contract but has
 * not been exercised live. See the deliverables report.
 *
 * Usage: npx tsx scripts/run-benchmark.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { estimatePoseViaPython } from "../src/lib/vision/cv-scripts";
import { detectCourt } from "../src/lib/vision/court";
import { trackPlayersByIoU } from "../src/lib/vision/tracker";
import { analyzeMovement } from "../src/lib/vision/movement";
import { detectUnknownShotEvents, detectFootworkFoundation } from "../src/lib/vision/events";
import type { FrameDetectionSet, PlayerPoseFrame } from "../src/lib/vision/phase2-types";

const execFileAsync = promisify(execFile);

const VIDEO_PATH = "/home/claude/benchmark/benchmark.mp4";
const VISION_FPS = 5;
const OUT_DIR = "/home/claude/pb-analyzer/benchmark-results";
const FRAMES_DIR = path.join(OUT_DIR, "frames");

async function probeVideo(videoPath: string) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", videoPath,
  ]);
  const raw = JSON.parse(stdout);
  const v = raw.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  return {
    durationSeconds: Number(raw.format.duration),
    width: v.width as number,
    height: v.height as number,
  };
}

async function extractFrames(videoPath: string, durationSeconds: number, fps: number, outDir: string) {
  await fs.mkdir(outDir, { recursive: true });
  // A single fps-filtered decode pass is far faster than seeking to each
  // timestamp individually (691 separate `-ss` seeks took ~5.5 minutes in
  // an earlier run of this harness — this single-pass approach does the
  // same 691 frames in a fraction of that, since it decodes the video
  // once instead of re-opening/re-seeking it per frame).
  const pattern = path.join(outDir, "frame-%04d.jpg");
  await execFileAsync("ffmpeg", [
    "-y", "-i", videoPath, "-vf", `fps=${fps}`, "-q:v", "3", pattern,
  ], { maxBuffer: 20 * 1024 * 1024 });

  const files = (await fs.readdir(outDir)).filter((f) => f.endsWith(".jpg")).sort();
  return files.map((f, i) => ({
    path: path.join(outDir, f),
    timestampSeconds: Math.round((i / fps) * 100) / 100,
  }));
}

async function main() {
  console.log("== Phase 2 CV pipeline — benchmark run ==");
  const meta = await probeVideo(VIDEO_PATH);
  console.log("video:", meta);

  console.log(`\nExtracting frames at VISION_FPS=${VISION_FPS} ...`);
  const t0 = Date.now();
  const frames = await extractFrames(VIDEO_PATH, meta.durationSeconds, VISION_FPS, FRAMES_DIR);
  console.log(`extracted ${frames.length} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log("\nDetecting court (classical CV, best of several candidate frames) ...");
  const candidateIndices = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => Math.floor(frames.length * f));
  let courtCalibration = await detectCourt(frames[candidateIndices[0]]);
  for (const idx of candidateIndices.slice(1)) {
    const candidate = await detectCourt(frames[idx]);
    console.log(`  candidate frame @${frames[idx].timestampSeconds}s -> confidence ${candidate.confidence}`);
    if (candidate.confidence > courtCalibration.confidence) courtCalibration = candidate;
  }
  console.log("court calibration (best):", JSON.stringify(courtCalibration, null, 2));

  console.log("\nRunning YOLOv8n-pose across all sampled frames (person boxes stand in for Roboflow detections + real pose keypoints) ...");
  const t1 = Date.now();
  const rawPoseResults = await estimatePoseViaPython(frames.map((f) => f.path));
  console.log(`pose+detection done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  const byPath = new Map(rawPoseResults.map((r) => [r.imagePath, r]));
  const perFrameDetections: FrameDetectionSet[] = frames.map((f) => {
    const raw = byPath.get(f.path);
    const players = (raw?.people ?? [])
      .filter((p) => (p.detectionConfidence ?? 0) >= 0.35)
      .map((p) => ({
        confidence: p.detectionConfidence ?? 0,
        boxImageNorm: p.boxImageNorm,
        timestampSeconds: f.timestampSeconds,
      }));
    return { timestampSeconds: f.timestampSeconds, framePath: f.path, players };
  });

  const playerCounts = perFrameDetections.map((f) => f.players.length);
  console.log(
    "players/frame — min/mean/max:",
    Math.min(...playerCounts),
    (playerCounts.reduce((a, b) => a + b, 0) / playerCounts.length).toFixed(2),
    Math.max(...playerCounts)
  );

  console.log("\nTracking players (IoU tracker) ...");
  const tracks = trackPlayersByIoU(perFrameDetections);
  for (const t of tracks) {
    console.log(
      `  ${t.playerId}: ${t.points.length} points, ${t.points[0].timestampSeconds}s -> ${t.points[t.points.length - 1].timestampSeconds}s`
    );
  }

  console.log("\nLinking pose keypoints to tracks ...");
  const poses: PlayerPoseFrame[] = [];
  for (const frame of frames) {
    const raw = byPath.get(frame.path);
    if (!raw) continue;
    for (const person of raw.people) {
      let bestTrack: (typeof tracks)[number] | null = null;
      let bestIou = 0;
      for (const track of tracks) {
        const point = track.points.find((p) => p.timestampSeconds === frame.timestampSeconds);
        if (!point) continue;
        const a = point.boxImageNorm, b = person.boxImageNorm;
        const ix1 = Math.max(a.x, b.x), iy1 = Math.max(a.y, b.y);
        const ix2 = Math.min(a.x + a.width, b.x + b.width), iy2 = Math.min(a.y + a.height, b.y + b.height);
        const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
        const inter = iw * ih;
        const union = a.width * a.height + b.width * b.height - inter;
        const iouScore = union > 0 ? inter / union : 0;
        if (iouScore > bestIou) { bestIou = iouScore; bestTrack = track; }
      }
      if (!bestTrack || bestIou < 0.2) continue;
      poses.push({
        playerId: bestTrack.playerId,
        timestampSeconds: frame.timestampSeconds,
        detectionConfidence: person.detectionConfidence,
        keypoints: person.keypoints as PlayerPoseFrame["keypoints"],
        modelSource: "yolov8n-pose",
      });
    }
  }
  console.log(`  ${poses.length} pose frames linked to tracks`);

  console.log("\nComputing movement metrics (court transform + speed/distance) ...");
  const movement = tracks.map((t) => analyzeMovement(t, courtCalibration, meta.width, meta.height));
  for (const m of movement) {
    console.log(
      `  ${m.playerId}: transformed ${m.transformedSampleCount}/${m.totalSampleCount} points, ` +
      `distance=${m.distanceCoveredMetersApprox ?? "null"}m (approx), avgSpeed=${m.averageSpeedCourtUnitsPerSecond ?? "null"} units/s`
    );
  }

  console.log("\nFootwork-foundation measurements (possible_split_step candidates) ...");
  const footwork = tracks.map((t) => detectFootworkFoundation(t));
  for (const f of footwork) {
    console.log(`  ${f.playerId}: lateralRange=${f.lateralRangeCourtUnits?.toFixed(3)}, possibleSplitSteps=${f.possibleSplitSteps.length}`);
  }

  console.log("\nDetecting unknown_shot events (audio onset) ...");
  const { events: shotEvents, diagnostics: audioDiag } = await detectUnknownShotEvents(VIDEO_PATH);
  console.log("  audio diagnostics:", audioDiag);
  console.log(`  ${shotEvents.length} unknown_shot events`);

  const allEvents = [...shotEvents];
  for (const f of footwork) {
    for (const c of f.possibleSplitSteps) {
      allEvents.push({ type: "possible_split_step", timestampSeconds: c.timestampSeconds, playerId: f.playerId, confidence: c.confidence, source: "movement-heuristic" });
    }
  }
  allEvents.sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const quality = {
    videoDurationSeconds: meta.durationSeconds,
    visionFps: VISION_FPS,
    framesSampled: frames.length,
    courtCalibrationConfidence: courtCalibration.confidence,
    playersDetectedPerFrame: {
      min: Math.min(...playerCounts),
      max: Math.max(...playerCounts),
      mean: Math.round((playerCounts.reduce((a, b) => a + b, 0) / playerCounts.length) * 100) / 100,
    },
    tracksProduced: tracks.length,
    poseFramesLinked: poses.length,
    audioEventCount: shotEvents.length,
  };

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, "result.json"),
    JSON.stringify({ meta, courtCalibration, tracks, movement, footwork, events: allEvents, quality }, null, 2)
  );
  console.log(`\nWrote ${path.join(OUT_DIR, "result.json")}`);
  console.log("\nQuality summary:", JSON.stringify(quality, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
