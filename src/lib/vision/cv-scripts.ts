import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";

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
import { overlayFps } from "../coaching/read-rate";

const POSE_MODEL_PATH = path.join(process.cwd(), "models", "yolov8n-pose.pt");

export class PythonCvError extends Error {}

/**
 * How long any one CV script may run before it is presumed wedged.
 *
 * There was no bound here at all, and the failure it allowed is the worst
 * kind: a run sat on "Tracking the ball" for TEN HOURS. Nothing in the stack
 * could end it. execFile without `timeout` waits forever; the AbortSignal
 * only fires when a human presses stop; and `inference`'s get_model() pulls
 * model weights over HTTPS with no timeout of its own, so a half-open
 * connection hangs the interpreter rather than failing it. A stalled download
 * and a healthy slow pass look identical from Node.
 *
 * 45 minutes is deliberately generous -- the slowest honest ball pass
 * measured on this app is ~29 minutes for a 101s clip -- because killing real
 * work is worse than waiting. What matters is that the number is finite.
 */
const DEFAULT_CV_TIMEOUT_MS = 45 * 60 * 1000;

export function cvTimeoutMs(): number {
  const raw = Number(process.env.CV_STEP_TIMEOUT_MS ?? DEFAULT_CV_TIMEOUT_MS);
  // A zero or negative timeout would kill every script the instant it started.
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CV_TIMEOUT_MS;
}

/**
 * A timeout proportional to the work, for the passes that scale with frames.
 *
 * A FLAT NUMBER WAS WRONG AND I SHOULD HAVE SEEN IT. 45 minutes was chosen
 * against a 101-second clip, where every stage finishes in single-digit
 * minutes. A 14-minute clip produces 4,121 frames, and a stage that honestly
 * needs an hour on that footage would be SIGKILLed by a bound tuned on
 * something 8x smaller -- killing real work and reporting it as "waiting on
 * something that never answered", which is exactly the wrong diagnosis.
 *
 * So the bound scales with frame count, with a floor for short clips and a
 * ceiling that still catches a genuine hang. `secondsPerFrame` is deliberately
 * loose: it is not a performance target, it is the point past which something
 * is clearly broken rather than slow.
 */
export function frameScaledTimeoutMs(
  frameCount: number,
  secondsPerFrame = 3,
  floorMs = 10 * 60 * 1000,
  ceilingMs = 3 * 60 * 60 * 1000
): number {
  const override = Number(process.env.CV_STEP_TIMEOUT_MS ?? NaN);
  if (Number.isFinite(override) && override > 0) return Math.round(override);
  const scaled = Math.max(0, frameCount) * secondsPerFrame * 1000;
  // ROUNDED, and this line is the whole reason the overlay never rendered.
  //
  // Node's execFile rejects a non-integer `timeout` outright -- "The value of
  // "timeout" is out of range. It must be an unsigned integer. Received
  // 207600.00000000003". A fractional secondsPerFrame (0.05 for the overlay)
  // times a frame count is binary floating point, so the product is a hair off
  // a whole number roughly always. The timeout added to make the longest stage
  // in the pipeline safe was instead the thing that stopped it running at all,
  // and it threw before Python was ever spawned -- which is why it failed
  // instantly and identically on every clip.
  return Math.round(Math.min(ceilingMs, Math.max(floorMs, scaled)));
}

async function runPython(
  scriptName: string,
  args: string[],
  opts: {
    maxBuffer?: number; streamStderr?: boolean; stdin?: string; timeoutMs?: number;
    /** Extra environment for this call only, merged over the process's own. */
    env?: Record<string, string>;
  } = {}
): Promise<string> {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  const timeoutMs = opts.timeoutMs ?? cvTimeoutMs();
  try {
    const child = execFileAsync(cvPython(), [scriptPath, ...args], {
      maxBuffer: opts.maxBuffer ?? 20 * 1024 * 1024,
      // Node kills the child when this aborts. Without it, "stop" would mean
      // "stop once the current Python script finishes", which for a full-clip
      // ball pass is minutes away.
      signal: activeRunSignal(),
      // The backstop for everything the signal cannot reach: a wedged
      // download, a deadlocked native extension, a script waiting on a socket
      // nobody will ever answer. SIGKILL rather than SIGTERM because a process
      // stuck inside a C extension may never handle a catchable signal.
      //
      // Rounded again here. Every caller should hand over an integer, and one
      // that does not must not be able to kill a stage before it starts.
      timeout: Math.round(timeoutMs),
      killSignal: "SIGKILL",
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
    // Tell a timeout apart from a crash. They need opposite fixes -- a crash
    // is a bug in the script, a timeout is usually the network or the box --
    // and a timeout reported as "exited with code null" sends every
    // investigation to the wrong place.
    const killedByTimeout = Boolean((err as { killed?: boolean })?.killed)
      && !activeRunSignal()?.aborted;
    if (killedByTimeout) {
      throw new PythonCvError(
        `${scriptName} was still running after ${Math.round(timeoutMs / 60_000)} min and was stopped. `
        + "This usually means it was waiting on something that never answered — a model download "
        + "or a hosted inference call — rather than doing slow work. "
        + "Raise CV_STEP_TIMEOUT_MS if this clip genuinely needs longer.\n"
        + stderr.trimEnd().split("\n").slice(-4).join("\n")
      );
    }
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
  // The weights, checked BEFORE the model is asked for them.
  //
  // ultralytics treats a path it cannot find as a model NAME and goes to
  // GitHub for it. On a laptop that download succeeds and nobody notices the
  // file was missing; in a container with no egress it fails, and it fails
  // from inside the batch loop, which reports it as per-frame data rather than
  // as a crash. The result is an analysis that finishes with no pose data and
  // no explanation. A missing file should say so, here, in one line.
  if (!fs.existsSync(POSE_MODEL_PATH)) {
    throw new PythonCvError(
      `the pose model is not at ${POSE_MODEL_PATH}. `
      + "Nothing will download it at runtime -- add models/yolov8n-pose.pt to the image."
    );
  }
  // streamStderr, like the ball and player passes. This is the longest stage in
  // the pipeline on a full-length clip and it printed nothing at all, so from
  // outside it was indistinguishable from a hang -- which is precisely the
  // ambiguity that has cost several evenings of guessing.
  // THROUGH A FILE, NOT A PIPE.
  //
  // execFile buffers a child's stdout in memory and kills it past maxBuffer. A
  // 13.7-minute clip at 5fps is 4,121 frames, and at seven people in shot that
  // is ~49MB of JSON against a 50MB cap -- under it by a rounding error, and
  // over it the moment a spectator or an adjacent court is in frame. So the
  // pose pass died on long clips for a reason that had nothing to do with
  // pose, and the symptom was a run that stopped responding.
  //
  // A file has no ceiling, and nothing is held twice.
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pb-pose-"));
  const outPath = path.join(outDir, "pose.jsonl");
  let raw: string;
  try {
    await runPython("estimate_pose.py",
      [...imagePaths, "--model", POSE_MODEL_PATH, "--out", outPath], {
        streamStderr: true,
        timeoutMs: frameScaledTimeoutMs(imagePaths.length),
      });
    raw = await fsp.readFile(outPath, "utf8");
  } finally {
    await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
  const stdout = raw;
  // ONLY THE JSON LINES.
  //
  // ultralytics writes some of its warnings to STDOUT rather than stderr --
  // "WARNING ⚠️ ..." -- and one of those landing in the middle of the JSONL
  // stream made JSON.parse throw, which took down the entire pose pass for the
  // clip. Every frame's result was already sitting in that same stdout,
  // perfectly good, discarded because of a line about a default setting.
  //
  // estimate_pose.py now keeps its stdout clean, so this should never fire.
  // It stays because the failure it prevents is total and the cost of
  // surviving it is one startsWith.
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const jsonLines = lines.filter((l) => l.startsWith("{"));
  const skipped = lines.length - jsonLines.length;
  if (skipped > 0) {
    console.error(`[cv] pose: ignored ${skipped} non-JSON line(s) on stdout, first: ${
      lines.find((l) => !l.startsWith("{"))?.slice(0, 120)}`);
  }
  return jsonLines.map((line) => JSON.parse(line) as RawPoseResult);
}

/**
 * People and their joints, in ONE model pass.
 *
 * WHY THIS REPLACES THE PLAYER DETECTOR. The pipeline ran two neural networks
 * over the same frames: yolov8n.pt for player boxes, then yolov8n-pose.pt for
 * skeletons. But a pose model detects people itself -- it returns a person box
 * with every skeleton, because that is how it finds the body to put joints on.
 * The separate detector was doing a job that was already being done, on a
 * machine where CPU inference is the entire bottleneck.
 *
 * One pass now. Half the model time, and boxes and skeletons that came from
 * the same look at the same pixels, so they can never disagree about where a
 * person is -- which the two-model version could, and did, whenever the IoU
 * match between them failed.
 */
export async function detectPeopleWithPose(
  frames: Array<{ path: string; timestampSeconds: number }>
): Promise<Map<string, RawPoseResult["people"]>> {
  const raw = await estimatePoseViaPython(frames.map((f) => f.path));
  const out = new Map<string, RawPoseResult["people"]>();
  for (const r of raw) out.set(r.imagePath, r.error ? [] : r.people);
  return out;
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
      { streamStderr: true, timeoutMs: frameScaledTimeoutMs(framePaths.length) });
    const raw = JSON.parse(await fsp.readFile(outPath, "utf8")) as RawPlayerDetections;
    const byPath = new Map<string, RawPlayerDetections["frames"][number]["players"]>();
    for (const f of raw.frames) byPath.set(f.imagePath, f.players);
    return byPath;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export class PaddleModelNotConfiguredError extends Error {}


export interface MedianFrameResult {
  out: string;
  samples: number;
  width: number;
  height: number;
}

/**
 * A player-free still of the court, for anything that needs to see the lines.
 *
 * Returns null rather than throwing on any failure. Every caller has a real
 * frame to fall back to, and a court fit on a frame with players in it is the
 * behaviour that existed before this — degraded, not broken. Losing a whole
 * analysis because a median could not be computed would be a bad trade for an
 * improvement to one step.
 */
export async function medianFrameViaPython(
  videoPath: string,
  outPath: string,
  opts: { samples?: number; maxDimension?: number } = {}
): Promise<MedianFrameResult | null> {
  const args = [videoPath, "--out", outPath];
  if (opts.samples) args.push("--samples", String(opts.samples));
  // Default to a cap because the median allocates a float64 copy of the whole
  // stack: at 1080p over 60 frames that is ~1.5GB resident, which is enough
  // to OOM the box mid-run.
  args.push("--max-dim", String(opts.maxDimension ?? 1280));
  try {
    // Minutes of timeout would be wrong here: this is a seek-and-decode loop
    // over a few dozen frames, so anything past a couple of minutes means it
    // is wedged, and the caller has a fallback.
    const stdout = await runPython("median_frame.py", args, { timeoutMs: 120_000 });
    return JSON.parse(stdout) as MedianFrameResult;
  } catch (err) {
    console.warn(`[median] could not build a player-free frame: ${(err as Error).message.split("\n")[0]}`);
    return null;
  }
}

/**
 * Render the annotated overlay.
 *
 * ROUTED THROUGH runPython, which it was not.
 *
 * debug-render.ts spawned execFile directly, so the longest stage in the
 * pipeline was also the only one with none of what runPython provides: no
 * timeout (a wedged render ran forever), no abort signal (pressing "Stop
 * analysis" did nothing to it), and no streamed stderr -- so a sixteen-minute
 * render reported absolutely nothing until it finished, which is why two
 * failed runs in a row said only "stopped responding" with no indication of
 * how far it had got.
 *
 * The timeout scales with frames because this draws on the source at its own
 * rate: a 20-minute match is ~35,000 frames against a short clip's 700.
 */
export async function renderOverlayViaPython(
  videoPath: string,
  dataPath: string,
  outPath: string,
  opts: {
    startS?: number; endS?: number; sourceFrames: number;
    /**
     * The identity clip: boxes and their ids and nothing else, at this frame
     * rate and height. Everything else on the overlay -- court, net, ball,
     * skeletons -- is noise for the one question that clip is asked.
     */
    boxesOnly?: { fps: number; maxHeight: number };
  } = { sourceFrames: 1 }
): Promise<void> {
  const args = [
    path.resolve(videoPath), "--data", dataPath, "--out", outPath,
    // ASKED FOR, not assumed.
    //
    // The overlay is the coaching model's input, and the model samples it at
    // analystFps(). Writing it any slower hands the model duplicate frames: it
    // cannot sample fifteen distinct frames a second out of a ten-frame-a-
    // second video, so the extra samples carry nothing and the run is billed
    // at the higher rate for the lower rate's information.
    //
    // This shipped wrong once -- the read rate was raised and the write rate
    // was not -- which is exactly what happens when two files each hold their
    // own copy of one number.
    "--out-fps", String(opts.boxesOnly ? opts.boxesOnly.fps : overlayFps()),
  ];
  if (opts.boxesOnly) args.push("--boxes-only");
  if (opts.startS !== undefined && opts.endS !== undefined) {
    args.push("--start", opts.startS.toFixed(3), "--end", opts.endS.toFixed(3));
  }
  await runPython("render_debug.py", args, {
    streamStderr: true,
    env: opts.boxesOnly ? { OVERLAY_MAX_HEIGHT: String(opts.boxesOnly.maxHeight) } : undefined,
    timeoutMs: frameScaledTimeoutMs(Math.max(1, opts.sourceFrames), 0.05, 2 * 60_000, 40 * 60_000),
  });
}
