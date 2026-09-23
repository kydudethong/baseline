/**
 * Court geometry from the `rally_seg` classical fitter (../coach/ml).
 *
 * This app's own detector (court.ts, `classical-cv-hsv-contour`) finds the
 * court by colour-masking and taking a contour. On footage shot from a low
 * tripod behind the baseline it returns a ~60px sliver pinned to the bottom of
 * the frame and reports 0.777 confidence for it, which is the worst possible
 * failure: a wrong homography corrupts every out-of-bounds call, every
 * "is this player on the court" test, and every distance-covered figure, while
 * looking confident enough that nothing downstream questions it.
 *
 * rally_seg fits the court differently. It masks the white paint, clusters the
 * Hough lines in (theta, rho) so a sideline at 23 degrees is not miscategorised
 * as a baseline, then searches quads and scores each one on two things: how
 * much of the paint it *explains* (the kitchen and centre lines a correct fit
 * predicts), and whether the regions it says are blank court really are blank.
 * The second half matters -- rewarding "lines land on white" alone lets a quad
 * squeeze the whole 44ft court onto the near half and score well. Finally it
 * fits every sampled frame independently and takes the consensus, because the
 * correct court is the one that keeps recurring.
 *
 * Verified against hand-marked corners on the reference clip: predicted kitchen
 * line at y=420-424 against real paint at 418-440, near baseline at y=648-662
 * against 649-660.
 *
 * Never throws. Every failure returns null and the caller falls back to this
 * app's own detector, because a better court is not worth an analysis run.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CourtCalibration, CourtCorners } from "./phase2-types";
import { activeRunSignal } from "../analysis/run-registry";

/** Line segments in source-frame pixels, keyed by which court marking they are. */
export type CourtLinesPx = Record<string, [[number, number], [number, number]]>;

interface RawCourt {
  /** Clockwise from the near-left baseline corner. */
  corners_px: [number, number][];
  confidence: number;
  agreement: number;
  extent: "full" | "near_half";
  source: string;
  image_size: [number, number];
  lines_px: CourtLinesPx;
}

export interface RallySegSetupFrame {
  timestampSeconds: number;
  /** Absolute path of the JPEG that was written, when one was asked for. */
  path: string | null;
  detector: string;
  /**
   * False when the player boxes came from the motion fallback. Those are built
   * from a background model of *consecutive* frames, and these frames are
   * seconds apart, so they are noise wearing a detector's clothes. The UI asks
   * the user to click instead, which is a small chore where four confident
   * wrong boxes would be a trap.
   */
  playersReliable: boolean;
  /**
   * People found in the frame who are not standing on this court -- the queue
   * behind the fence, the next court over, spectators. Meaningful only when
   * `courtGated` is true: with no court there is nothing to be outside of, so
   * a zero here means "not judged", not "none".
   */
  playersOffCourt: number;
  courtGated: boolean;
}

export interface RallySegSetup {
  imageSize: [number, number];
  calibration: CourtCalibration | null;
  courtReason: string | null;
  frame: RallySegSetupFrame | null;
  players: Array<{
    boxPx: [number, number, number, number];
    feetPx: [number, number];
    confidence: number;
    side: "near" | "far" | null;
  }>;
}

function rallySegDir(): string {
  return process.env.RALLY_SEG_DIR || path.join(os.homedir(), "coach", "ml");
}

function pythonBin(): string {
  if (process.env.RALLY_SEG_PYTHON) return process.env.RALLY_SEG_PYTHON;
  const venv = path.join(rallySegDir(), ".venv", "bin", "python");
  return fs.existsSync(venv) ? venv : "python3";
}

export function rallySegInstalled(): boolean {
  return fs.existsSync(path.join(rallySegDir(), "rally_seg", "__init__.py"));
}

/** Opt out with `RALLY_SEG_COURT=off`. On by default once rally_seg is present. */
export function rallySegCourtEnabled(): boolean {
  const v = (process.env.RALLY_SEG_COURT || "on").toLowerCase();
  return v !== "off" && v !== "0" && v !== "false" && rallySegInstalled();
}

/**
 * rally_seg's corners into this app's.
 *
 * The two name corners differently and it is worth being explicit about why
 * they still line up. rally_seg starts at the baseline nearest the camera and
 * goes round; this app names them by position in the image. Filmed from behind
 * a baseline, "near" is the bottom of the frame, so near-left is bottomLeft.
 * That correspondence is a property of the camera position, not a coincidence,
 * and it is the same one setupCourtForRallySeg() relies on in the other
 * direction.
 */
function toCorners(pts: [number, number][]): CourtCorners | null {
  if (!Array.isArray(pts) || pts.length !== 4) return null;
  if (!pts.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) return null;
  const [nearLeft, nearRight, farRight, farLeft] = pts;
  return { bottomLeft: nearLeft, bottomRight: nearRight, topRight: farRight, topLeft: farLeft };
}

/**
 * Rescale corners fitted on rally_seg's (possibly downscaled) frame into the
 * source video's pixel space, which is what everything downstream measures in.
 */
function rescale(pts: [number, number][], from: [number, number], to: [number, number]): [number, number][] {
  // A non-positive size on either side means "unknown", and guessing a scale
  // factor from an unknown is how coordinates end up silently at the origin.
  if (!from || from[0] <= 0 || from[1] <= 0) return pts;
  if (!to || to[0] <= 0 || to[1] <= 0) return pts;
  const sx = to[0] / from[0];
  const sy = to[1] / from[1];
  if (Math.abs(sx - 1) < 1e-6 && Math.abs(sy - 1) < 1e-6) return pts;
  return pts.map(([x, y]) => [x * sx, y * sy] as [number, number]);
}

function toCalibration(
  raw: RawCourt,
  frameSize: [number, number],
  timestampSeconds: number
): CourtCalibration | null {
  const corners = toCorners(rescale(raw.corners_px, raw.image_size, frameSize));
  if (!corners) return null;

  const lines: CourtLinesPx = {};
  for (const [name, seg] of Object.entries(raw.lines_px ?? {})) {
    const scaled = rescale(seg as [number, number][], raw.image_size, frameSize);
    lines[name] = [scaled[0], scaled[1]];
  }

  // court_calibrations.confidence is constrained to 0..1 in the schema, and a
  // score built by subtracting a negative-region penalty from line support can
  // in principle land outside it. Clamping here keeps a scoring change from
  // failing an entire analysis run on a check constraint.
  const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0));

  return {
    method: "rally_seg-classical",
    confidence,
    cornersImagePx: corners,
    quadKind: raw.extent === "near_half" ? "near-half" : "full",
    frameTimestampSeconds: timestampSeconds,
    diagnostics: {
      // Kept separate from confidence on purpose. Line support says how much
      // of the paint this quad explains; agreement says how many independently
      // fitted frames landed on it. They fail differently and averaging them
      // into one number hides which one went wrong.
      lineSupport: confidence,
      agreement: raw.agreement,
      extent: raw.extent,
      source: raw.source,
      fittedImageSize: raw.image_size,
      quadKind: raw.extent === "near_half" ? "near-half" : "full",
      linesPx: lines,
    },
  };
}

/**
 * Fit the court on a video, with rally_seg.
 *
 * Costs one pass of sampled frames (24 by default), not a full decode.
 */
export async function detectCourtViaRallySeg(
  videoPath: string,
  frameSize: [number, number],
  onLog?: (line: string) => void,
  configOverrides?: Array<[string, string]>
): Promise<CourtCalibration | null> {
  if (!rallySegInstalled()) return null;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "rsc-"));
  const jsonPath = path.join(work, "court.json");
  try {
    const args = ["-m", "rally_seg", "court", path.resolve(videoPath),
                  "--json", jsonPath, "--quiet"];
    for (const [key, value] of configOverrides ?? []) args.push("--set", `${key}=${value}`);
    await run(pythonBin(), args, rallySegDir(), onLog);
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    if (!raw?.court) {
      if (raw?.reason) onLog?.(`rally_seg could not fit the court: ${raw.reason}`);
      return null;
    }
    return toCalibration(raw.court as RawCourt, frameSize, 0);
  } catch (err) {
    // Exit code 2 is "no court found", which is a result, not a fault.
    onLog?.(`rally_seg court fit unavailable: ${(err as Error).message}`);
    return null;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Pick the frame to run pre-analysis setup on, and say who is standing in it.
 *
 * Scrubbing a video hunting for the moment all four players are on court is a
 * chore, and it is one a detector can do exhaustively in less time than it
 * takes to explain. The frame that wins is the one with four people on the
 * court, two a side, not overlapping each other -- because the question the
 * setup step exists to ask ("which one is you?") is unanswerable on a frame
 * where two players are stood in front of each other.
 */
export async function setupFrameViaRallySeg(
  videoPath: string,
  frameSize: [number, number],
  outFramePath: string | null,
  onLog?: (line: string) => void,
  configOverrides?: Array<[string, string]>,
  /**
   * Look only inside these seconds.
   *
   * THE FRAME IS CHOSEN, NOT ASKED FOR -- which is right until the one it
   * chooses is one the user cannot work with: a player behind the net post,
   * the camera still being carried, the wrong end of a clip holding two
   * games. Then they need to say "look around here instead", and this is how
   * the setup page says it. Undefined scans the whole clip, as before.
   */
  window?: { startSeconds: number; endSeconds: number },
): Promise<RallySegSetup | null> {
  if (!rallySegInstalled()) return null;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "rss-"));
  const jsonPath = path.join(work, "setup.json");
  try {
    const args = ["-m", "rally_seg", "setup", path.resolve(videoPath), "--json", jsonPath, "--quiet"];
    // The setup screen re-runs detection after the user picks a line colour,
    // which is the only way picking one can pay off before the analysis: a
    // court that would not fit against white gets another go against the
    // colour that is actually painted on it.
    for (const [key, value] of configOverrides ?? []) args.push("--set", `${key}=${value}`);
    if (window && window.endSeconds > window.startSeconds) {
      args.push("--start", Math.max(0, window.startSeconds).toFixed(2));
      args.push("--end", window.endSeconds.toFixed(2));
    }
    if (outFramePath) {
      fs.mkdirSync(path.dirname(outFramePath), { recursive: true });
      args.push("--out-frame", outFramePath);
    }
    await run(pythonBin(), args, rallySegDir(), onLog);
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

    const fitted: [number, number] = raw.image_size ?? frameSize;
    // Everything is reported in one space, and it is the source video's, so
    // the caller never has to reason about rally_seg's internal downscale.
    // When the caller does not know the video's size (the probe has not run
    // yet), rally_seg's own frame size is the honest answer.
    const target: [number, number] =
      frameSize && frameSize[0] > 0 && frameSize[1] > 0 ? frameSize : fitted;
    const sx = fitted[0] > 0 ? target[0] / fitted[0] : 1;
    const sy = fitted[1] > 0 ? target[1] / fitted[1] : 1;
    const ts = Number(raw.frame?.timestamp_s ?? 0);

    return {
      imageSize: target,
      calibration: raw.court ? toCalibration(raw.court as RawCourt, target, ts) : null,
      courtReason: raw.court_reason ?? null,
      frame: raw.frame
        ? {
            timestampSeconds: ts,
            path: raw.frame.path ?? null,
            detector: String(raw.frame.detector ?? "unknown"),
            playersReliable: raw.frame.players_reliable !== false,
            playersOffCourt: Number(raw.frame.players_off_court ?? 0) || 0,
            courtGated: raw.frame.court_gate === true,
          }
        : null,
      players: (raw.players ?? []).map((p: {
        box_px: [number, number, number, number];
        feet_px: [number, number];
        confidence: number;
        side: "near" | "far" | null;
      }) => ({
        boxPx: [p.box_px[0] * sx, p.box_px[1] * sy, p.box_px[2] * sx, p.box_px[3] * sy] as
          [number, number, number, number],
        feetPx: [p.feet_px[0] * sx, p.feet_px[1] * sy] as [number, number],
        confidence: p.confidence,
        side: p.side ?? null,
      })),
    };
  } catch (err) {
    onLog?.(`rally_seg setup frame unavailable: ${(err as Error).message}`);
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
      signal,
    });
    let stderr = "";
    const timeout = Number(process.env.RALLY_SEG_COURT_TIMEOUT_MS || 8 * 60 * 1000);
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
      // 2 means "ran fine, found no court" -- the JSON is still written.
      if (code === 0 || code === 2) resolve();
      else reject(new Error(`exit ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`));
    });
  });
}
