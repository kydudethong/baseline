import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

// scripts/cv/*.py live at the repo root, two levels up from src/lib/vision.
const SCRIPTS_DIR = path.join(process.cwd(), "scripts", "cv");
const POSE_MODEL_PATH = path.join(process.cwd(), "models", "yolov8n-pose.pt");

export class PythonCvError extends Error {}

async function runPython(scriptName: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<string> {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  try {
    const { stdout } = await execFileAsync("python3", [scriptPath, ...args], {
      maxBuffer: opts.maxBuffer ?? 20 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr ?? "";
    throw new PythonCvError(`${scriptName} failed: ${(err as Error).message}\n${stderr}`);
  }
}

export interface RawCourtDetection {
  method: string;
  confidence: number;
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
export async function computeAppearanceSignaturesViaPython(
  imagePath: string,
  boxes: Array<{ x: number; y: number; width: number; height: number }>
): Promise<Array<RawAppearanceSignature | null>> {
  if (boxes.length === 0) return [];
  const stdout = await runPython("appearance_signature.py", [imagePath, JSON.stringify(boxes)]);
  return JSON.parse(stdout) as Array<RawAppearanceSignature | null>;
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

export interface RawAudioEvents {
  events: Array<{ timestampSeconds: number; strength: number }>;
  diagnostics: Record<string, unknown>;
}

export async function detectAudioEventsViaPython(videoPath: string): Promise<RawAudioEvents> {
  const stdout = await runPython("audio_events.py", [videoPath]);
  return JSON.parse(stdout) as RawAudioEvents;
}
