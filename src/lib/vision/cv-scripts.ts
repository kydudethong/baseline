import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

// scripts/cv/*.py live at the repo root, two levels up from src/lib/vision.
const SCRIPTS_DIR = path.join(process.cwd(), "scripts", "cv");

/**
 * Which Python runs the CV scripts.
 *
 * Hardcoding "python3" assumes the interpreter on PATH is the one carrying
 * this app's dependencies, and on a machine with a venv for adjacent work it
 * usually is not: one Python ends up with ultralytics, another with
 * `inference`, and which script fails depends on which package landed where.
 * Set CV_PYTHON to a specific interpreter (a venv's bin/python, say) to point
 * every script at one environment.
 */
export function cvPython(): string {
  return process.env.CV_PYTHON || "python3";
}
import { activeRunSignal } from "../analysis/run-registry";

const POSE_MODEL_PATH = path.join(process.cwd(), "models", "yolov8n-pose.pt");

export class PythonCvError extends Error {}

async function runPython(
  scriptName: string,
  args: string[],
  opts: { maxBuffer?: number; streamStderr?: boolean; stdin?: string } = {}
): Promise<string> {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  try {
    const child = execFileAsync(cvPython(), [scriptPath, ...args], {
      maxBuffer: opts.maxBuffer ?? 20 * 1024 * 1024,
      // Node kills the child when this aborts. Without it, "stop" would mean
      // "stop once the current Python script finishes", which for a full-clip
      // ball pass is minutes away.
      signal: activeRunSignal(),
    });
    // Long-running scripts report progress on stderr; forward it live so a
    // ten-minute ball pass doesn't look like a hang.
    if (opts.streamStderr) child.child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    // Large batched payloads go over stdin, not argv -- an argv string is
    // capped by the OS (ARG_MAX, ~256KB-1MB depending on platform), which a
    // clip with thousands of frames' worth of player boxes could exceed.
    if (opts.stdin !== undefined) {
      child.child.stdin?.end(opts.stdin);
    }
    const { stdout } = await child;
    return stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr ?? "";
    // Name the interpreter. "ultralytics is not installed" is baffling when
    // you have just installed it and watched it import -- because the shell
    // you tested in and the shell this server inherited its PATH from are not
    // the same, and `python3` resolves differently in each. Saying which
    // binary ran turns that into a one-line fix.
    // execFile puts the WHOLE command line in err.message, which for
    // a windowed pass means a hundred-plus window pairs -- thousands of
    // characters of coordinates burying the one line that says what actually
    // went wrong. Keep the first line, which names the exit code, and drop the
    // argument dump; the useful detail is always in stderr.
    const firstLine = ((err as Error).message || "").split("\n")[0].slice(0, 200);
    // Python tracebacks put the real cause last, not first.
    const tail = stderr.trimEnd().split("\n").slice(-4).join("\n");
    throw new PythonCvError(
      `${scriptName} failed (interpreter: ${cvPython()}${process.env.CV_PYTHON ? "" : ", from PATH"}). `
      + `${firstLine}\n${tail}`
      + (process.env.CV_PYTHON ? "" :
        "\nIf that package IS installed in your shell, the server is running a different python. "
        + "Run `which python3` and set CV_PYTHON to that path in .env.local.")
    );
  }
}

export type CourtQuadKind = "near-inplay" | "near-half" | "full";

export interface RawCourtDetection {
  method: string;
  confidence: number;
  /** Which physical rectangle the quad is — see detect_court.py's detect_with_masks(). Null when nothing was found. */
  quadKind: CourtQuadKind | null;
  cornersImagePx: {
    topLeft: [number, number];
    topRight: [number, number];
    bottomLeft: [number, number];
    bottomRight: [number, number];
  } | null;
  diagnostics: Record<string, unknown>;
}

export async function detectCourtViaPython(imagePath: string): Promise<RawCourtDetection> {
  const stdout = await runPython("detect_court.py", [imagePath]);
  return JSON.parse(stdout) as RawCourtDetection;
}

export interface RawAppearanceSignature {
  h: number;
  s: number;
  v: number;
}

/**
 * Mean HSV color signature per player box, sampled from the torso region.
 * Used only as a tie-breaker for track re-identification (tracker.ts) after
 * a track goes missing for too long — never a biometric identifier, never
 * required for the pipeline to function. Returns one entry per input box,
 * aligned by index; an entry is null if that box couldn't be sampled.
 * Callers should fail soft: a Python/OpenCV error here should not fail the
 * whole vision pipeline, since appearance signatures are an enhancement to
 * tracking, not a dependency of it.
 */
export interface AppearanceSignatureRequest {
  imagePath: string;
  boxes: Array<{ x: number; y: number; width: number; height: number }>;
}

/**
 * Batched across every frame in ONE Python process, mirroring
 * estimatePoseViaPython below -- this is classical CV (numpy/cv2 mean-HSV,
 * no model), so calling it once per frame was mostly paying Python
 * interpreter + import startup over and over rather than real work. One
 * process for the whole clip removes that repeated cost.
 */
export async function computeAppearanceSignaturesViaPython(
  requests: AppearanceSignatureRequest[]
): Promise<Map<string, Array<RawAppearanceSignature | null>>> {
  const withBoxes = requests.filter((r) => r.boxes.length > 0);
  if (withBoxes.length === 0) return new Map();
  const stdout = await runPython("appearance_signature.py", [], {
    stdin: JSON.stringify(withBoxes),
    maxBuffer: 50 * 1024 * 1024,
  });
  const results = new Map<string, Array<RawAppearanceSignature | null>>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as { imagePath: string; signatures: Array<RawAppearanceSignature | null> };
    results.set(parsed.imagePath, parsed.signatures);
  }
  return results;
}

export interface RawPoseResult {
  imagePath: string;
  error?: string;
  people: Array<{
    boxImageNorm: { x: number; y: number; width: number; height: number };
    detectionConfidence: number | null;
    keypoints: Array<{ name: string; xNorm: number | null; yNorm: number | null; confidence: number | null }>;
  }>;
}

/** Runs pose estimation on one or more full frames in a single Python process (model loaded once). */
export async function estimatePoseViaPython(imagePaths: string[]): Promise<RawPoseResult[]> {
  if (imagePaths.length === 0) return [];
  const stdout = await runPython("estimate_pose.py", [...imagePaths, "--model", POSE_MODEL_PATH], {
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RawPoseResult);
}

export interface RawBallDetections {
  fps: number;
  sourceFps: number;
  width: number;
  height: number;
  framesProcessed: number;
  detections: Array<{ t: number; frame: number; x: number; y: number; w: number; h: number; conf: number }>;
  diagnostics: Record<string, unknown>;
}

export class BallModelNotConfiguredError extends Error {}

/** True when a ball model is configured (a Roboflow model id or local weights) — the pipeline skips shots otherwise. */
export function ballModelConfigured(): boolean {
  return Boolean(process.env.BALL_MODEL_ID || process.env.BALL_MODEL_PATH);
}

/**
 * Runs detect_ball.py over the given rally windows at up to the clip's
 * native frame rate. Exit code 2 from the script means "no model
 * configured" and is surfaced as BallModelNotConfiguredError so the
 * pipeline can record shots as unavailable instead of failing the run.
 */
export async function detectBallViaPython(
  videoPath: string,
  windows: Array<[number, number]>
): Promise<RawBallDetections> {
  if (!ballModelConfigured()) throw new BallModelNotConfiguredError("No ball model configured (BALL_MODEL_ID / BALL_MODEL_PATH).");

  // Take the result through a file, not stdout.
  //
  // detect_ball.py is careful to keep stdout clean, but it does not own
  // stdout: the `inference` package and its transitive dependencies print
  // their own notices ("ModelDependencyMissing: ...", ONNX provider warnings),
  // and anything of theirs that lands on stdout is glued to the front of the
  // JSON. JSON.parse then throws on a run where detection actually worked --
  // the detector reports finding the ball in hundreds of frames, and the app
  // reports no ball at all. A file cannot be polluted by a library's chatter.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pb-ball-"));
  const outPath = path.join(dir, "detections.json");
  try {
    await runPython("detect_ball.py",
      [videoPath, "--windows", JSON.stringify(windows), "--out", outPath],
      { maxBuffer: 8 * 1024 * 1024, streamStderr: true });
    const text = await fsp.readFile(outPath, "utf8");
    try {
      return JSON.parse(text) as RawBallDetections;
    } catch (err) {
      throw new PythonCvError(
        `detect_ball.py wrote output that is not valid JSON (${(err as Error).message}). `
        + `First 200 characters: ${text.slice(0, 200)}`
      );
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}


/* -------------------------------------------------------------------------
 * Local player detection
 * ------------------------------------------------------------------------- */

export interface RawPlayerDetections {
  frames: Array<{
    imagePath: string;
    players: Array<{ boxImageNorm: { x: number; y: number; width: number; height: number }; confidence: number }>;
    error?: string;
  }>;
  model: string;
}

export class PlayerModelMissingError extends Error {}

export function localPlayerModelPath(): string {
  return process.env.PLAYER_MODEL_PATH || path.join(process.cwd(), "models", "yolov8n.pt");
}

/**
 * Detect people in a batch of frames, locally.
 *
 * One Python process for the whole clip rather than one network call per
 * frame. The hosted path this replaces spent a Roboflow credit per frame on
 * `coco/50` -- a public COCO detector whose `person` class was the only thing
 * ever read from it -- so a single 100-second clip at 5 fps was ~500 hosted
 * inferences, and a few re-runs exhausted a free tier. The same weights class
 * runs here for nothing.
 */
export async function detectPlayersViaPython(
  framePaths: string[]
): Promise<Map<string, Array<{ boxImageNorm: { x: number; y: number; width: number; height: number }; confidence: number }>>> {
  const model = localPlayerModelPath();
  if (!fsSync.existsSync(model)) {
    throw new PlayerModelMissingError(
      `Local player model not found at ${model}. Download yolov8n.pt into models/, or set PLAYER_MODEL_PATH.`
    );
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pb-players-"));
  const framesJson = path.join(dir, "frames.json");
  const outPath = path.join(dir, "players.json");
  try {
    await fsp.writeFile(framesJson, JSON.stringify(framePaths), "utf8");
    await runPython("detect_players.py",
      ["--frames-json", framesJson, "--model", model, "--out", outPath],
      { streamStderr: true });
    const raw = JSON.parse(await fsp.readFile(outPath, "utf8")) as RawPlayerDetections;
    const byPath = new Map<string, RawPlayerDetections["frames"][number]["players"]>();
    for (const f of raw.frames) byPath.set(f.imagePath, f.players);
    return byPath;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export class PaddleModelNotConfiguredError extends Error {}

