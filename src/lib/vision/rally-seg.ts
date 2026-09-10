/**
 * Rally boundaries from the `rally_seg` pipeline (../coach/ml).
 *
 * A second opinion on where rallies start and end, and a different kind of
 * argument. clusterRalliesFromHits (rallies.ts) groups paddle hits by the gaps
 * between them: a rally is a burst of contacts. That is a statistical argument
 * and it degrades gracefully, which is why it works.
 *
 * rally_seg makes a physical one. It tracks the ball, spots where the
 * trajectory stops being a single parabola, and separates a bounce from a
 * paddle by whether the impulse was vertical (the court cannot push sideways)
 * or a reversal of travel. Then it ends a rally on evidence a point is actually
 * over: a bounce that maps outside the lines, a ball that dies in the net, two
 * bounces with no paddle between them, or the next serve. In pickleball a
 * double bounce is unambiguous -- the point is done.
 *
 * It reuses the ball detections this pipeline already computed, so it costs a
 * video decode and no extra detector calls.
 *
 * Never throws. Every failure returns null and the caller falls back to
 * clusterRalliesFromHits, because a second opinion that can take down an
 * analysis run is worse than no second opinion.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CourtCalibration } from "./phase2-types";
import type { ClusteredRally } from "./rallies";
import type { RawBallDetections } from "./cv-scripts";
import { activeRunSignal } from "../analysis/run-registry";

/** Where the pipeline lives. Sibling checkout by default. */
function rallySegDir(): string {
  return process.env.RALLY_SEG_DIR || path.join(os.homedir(), "coach", "ml");
}

function pythonBin(): string {
  if (process.env.RALLY_SEG_PYTHON) return process.env.RALLY_SEG_PYTHON;
  const venv = path.join(rallySegDir(), ".venv", "bin", "python");
  return fs.existsSync(venv) ? venv : "python3";
}

/** Opt-in: `RALLY_SEGMENTER=rally_seg` in .env.local. Anything else uses hits. */
export function rallySegEnabled(): boolean {
  return (process.env.RALLY_SEGMENTER || "hits").toLowerCase() === "rally_seg";
}

/**
 * Render the annotated video alongside the timestamps.
 *
 * Costs a full decode and re-encode -- a minute or two for a short clip -- so
 * it is opt-in. Worth it while tuning: the overlay shows the ball trail, player
 * boxes with track ids, the court as the pipeline understands it, and a
 * coloured flash at every cut point with the reason written on it. Numbers tell
 * you a boundary is wrong; this tells you why.
 */
export function rallySegDebugEnabled(): boolean {
  const v = (process.env.RALLY_SEG_DEBUG || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Served by Next at /rally-debug/<id>.mp4. */
export function debugVideoDir(): string {
  return process.env.RALLY_SEG_DEBUG_DIR || path.join(process.cwd(), "public", "rally-debug");
}

export interface RallySegResult {
  rallies: ClusteredRally[];
  /** Per-rally detail the hits clusterer has no equivalent for. */
  detail: Array<{
    idx: number;
    startS: number;
    endS: number;
    clipStartS: number;
    clipEndS: number;
    confidence: number;
    startReason: string;
    endReason: string;
    netCrossings: number;
    bounces: number;
    shots: number;
  }>;
  warnings: string[];
  courtDetected: boolean;
  ballDetectionRate: number;
  /** Public URL of the annotated video, when one was rendered. */
  debugVideoUrl: string | null;
}

export interface RallySegInput {
  videoPath: string;
  durationSeconds: number;
  frameWidthPx: number;
  frameHeightPx: number;
  /** Raw per-frame detections as detect_ball.py produced them. */
  detections: RawBallDetections["detections"];
  fps: number;
  framesProcessed: number;
  calibration: CourtCalibration | null;
  /** Names the annotated video, so the UI can find it. Usually the analysis id. */
  debugId?: string;
  /**
   * A court the user marked by hand, in rally_seg's format. Outranks both this
   * app's automatic calibration and rally_seg's own fitting -- a person putting
   * four corners on the painted lines is more reliable than either.
   */
  courtOverride?: object | null;
  /**
   * Dotted `--set` pairs from the user's setup: the colour of the painted
   * lines, and how many players to expect. Passed as pairs rather than an
   * object so the caller decides what is worth overriding and this stays a
   * dumb conduit.
   */
  configOverrides?: Array<[string, string]>;
  onLog?: (line: string) => void;
}

/**
 * Hand this pipeline's court calibration over in the format rally_seg wants.
 *
 * Corner order differs: this app names them by image position, rally_seg wants
 * them starting at the baseline nearest the camera and going round. "near" is
 * the bottom of the frame, so bottom-left is the origin.
 */
function courtFile(cal: CourtCalibration | null, w: number, h: number): object | null {
  const c = cal?.cornersImagePx;
  if (!c) return null;

  // Sanity-check before handing it over. A wrong homography is worse than
  // none: it turns every out-of-bounds test into a coin flip and every
  // "is this player on the court" test with it, while still reporting
  // confident-looking numbers. This app's classical fit produces a ~50px
  // sliver pinned to the bottom of the frame on some clips and still calls it
  // 0.777 confident, so the confidence value cannot be trusted on its own.
  // Rejecting it lets rally_seg fit its own court, or say it could not.
  const pts = [c.bottomLeft, c.bottomRight, c.topRight, c.topLeft];
  if (pts.some((p) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) return null;

  const area = Math.abs(
    pts.reduce((sum, p, i) => {
      const q = pts[(i + 1) % pts.length];
      return sum + (p[0] * q[1] - q[0] * p[1]);
    }, 0) / 2
  );
  if (area < 0.05 * w * h) return null;

  const ys = pts.map((p) => p[1]);
  if (Math.max(...ys) - Math.min(...ys) < 0.12 * h) return null;

  const xs = pts.map((p) => p[0]);
  if (Math.max(...xs) - Math.min(...xs) < 0.20 * w) return null;

  // Corner order differs between the two. This app names corners by image
  // position; rally_seg starts at the baseline nearest the camera and goes
  // round, and "near" is the bottom of the frame.
  const extent = cal?.quadKind === "full" ? "full" : "near_half";
  return { corners_px: pts, extent, image_size: [w, h] };
}


/**
 * A hand-made calibration for this clip, if one exists.
 *
 * Looked up as `<RALLY_SEG_COURT_DIR>/<video basename>.court.json`, so a court
 * calibrated once can be reused for every clip filmed there just by naming the
 * file after the video.
 */
function manualCourtFor(videoPath: string): object | null {
  const dir = process.env.RALLY_SEG_COURT_DIR
    || path.join(rallySegDir(), "configs", "courts");
  const base = path.basename(videoPath).replace(/\.[^.]+$/, "");
  const file = path.join(dir, `${base}.court.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}


export async function segmentRalliesViaRallySeg(
  input: RallySegInput
): Promise<RallySegResult | null> {
  const dir = rallySegDir();
  if (!fs.existsSync(path.join(dir, "rally_seg", "__init__.py"))) {
    console.warn(`[rally-seg] not found at ${dir} — falling back to hit clustering`);
    return null;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "rallyseg-"));
  const detPath = path.join(work, "detections.json");
  const outPath = path.join(work, "rallies.json");

  try {
    fs.writeFileSync(
      detPath,
      JSON.stringify({
        fps: input.fps,
        sourceFps: input.fps,
        width: input.frameWidthPx,
        height: input.frameHeightPx,
        framesProcessed: input.framesProcessed,
        detections: input.detections,
      })
    );

    const wantDebug = rallySegDebugEnabled() && Boolean(input.debugId);
    let debugVideoPath: string | null = null;
    if (wantDebug) {
      fs.mkdirSync(debugVideoDir(), { recursive: true });
      debugVideoPath = path.join(debugVideoDir(), `${input.debugId}.mp4`);
    }

    const args = wantDebug
      ? ["-m", "rally_seg", "debug", path.resolve(input.videoPath),
         "--out", debugVideoPath!, "--json", outPath]
      : ["-m", "rally_seg", "segment", path.resolve(input.videoPath), "--out", outPath];
    args.push(
      "--set", "ball.backend=replay",
      "--set", `ball.replay_path=${detPath}`,
      "--no-cache",
    );

    // Whatever the user told us on the setup screen. Line colour changes what
    // the court fitter looks for; player count changes how many people the
    // tracker keeps. Both are things only the user knows, and both are wrong
    // by default on a court that is not white-lined doubles.
    for (const [key, value] of input.configOverrides ?? []) {
      args.push("--set", `${key}=${value}`);
    }
    if ((input.configOverrides ?? []).some(([k]) => k === "court.line_color_hex")) {
      input.onLog?.("fitting the court to the line colour you picked, not white");
    }

    // A hand-made calibration for this camera position beats anything either
    // app can fit automatically, so it wins outright when one exists. Four
    // clicks in ml/tools/calibrate_court.html, once per court, and every clip
    // filmed from that position gets exact geometry.
    const manual = input.courtOverride ?? manualCourtFor(input.videoPath);
    const court = manual ?? courtFile(input.calibration, input.frameWidthPx, input.frameHeightPx);
    if (!court && input.calibration?.cornersImagePx) {
      input.onLog?.("court calibration looked implausible and was not used");
    }
    if (court) {
      if (input.courtOverride) input.onLog?.("using the court you marked during setup");
      else if (manual) input.onLog?.("using the hand-made court calibration");
      const courtPath = path.join(work, "court.json");
      fs.writeFileSync(courtPath, JSON.stringify(court));
      args.push("--set", `court.manual_points_path=${courtPath}`);
    }

    await run(pythonBin(), args, dir, input.onLog);

    if (!fs.existsSync(outPath)) return null;
    const raw = JSON.parse(fs.readFileSync(outPath, "utf8"));
    const detail = (raw.rallies ?? []).map((r: Record<string, number | string>, i: number) => ({
      idx: i,
      startS: Number(r.start_s),
      endS: Number(r.end_s),
      clipStartS: Number(r.clip_start_s ?? r.start_s),
      clipEndS: Number(r.clip_end_s ?? r.end_s),
      confidence: Number(r.confidence ?? 0),
      startReason: String(r.start_reason ?? "unknown"),
      endReason: String(r.end_reason ?? "unknown"),
      netCrossings: Number(r.net_crossings ?? 0),
      bounces: Number(r.bounces ?? 0),
      shots: Number(r.shots ?? 0),
    }));

    return {
      rallies: detail.map((d: { idx: number; startS: number; endS: number }) => ({
        idx: d.idx, startS: d.startS, endS: d.endS, contacts: [],
      })),
      detail,
      warnings: raw.warnings ?? [],
      courtDetected: Boolean(raw.court_detected),
      ballDetectionRate: Number(raw.ball_detection_rate ?? 0),
      debugVideoUrl:
        debugVideoPath && fs.existsSync(debugVideoPath)
          ? `/rally-debug/${path.basename(debugVideoPath)}`
          : null,
    };
  } catch (err) {
    console.warn(`[rally-seg] failed, falling back: ${(err as Error).message}`);
    return null;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function run(
  bin: string, args: string[], cwd: string,
  onLog?: (s: string) => void,
  signal: AbortSignal | undefined = activeRunSignal()
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Analysis stopped."));
      return;
    }
    const proc = spawn(bin, args, {
      cwd,
      env: { ...process.env, PYTHONPATH: cwd, PYTHONUNBUFFERED: "1" },
      // rally_seg's pass is the longest single subprocess in the pipeline, so
      // it is the one that most needs to die on demand.
      signal,
    });
    let stderr = "";
    const timeout = Number(process.env.RALLY_SEG_TIMEOUT_MS || 30 * 60 * 1000);
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`timed out after ${Math.round(timeout / 1000)}s`));
    }, timeout);

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      const line = text.split(/[\r\n]/).filter(Boolean).pop();
      if (line && onLog) onLog(line.trim());
    });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`exit ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`));
    });
  });
}
