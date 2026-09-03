import fs from "node:fs/promises";
import type { BoundingBoxNorm, PlayerDetection } from "./phase2-types";

/**
 * Player detection via Roboflow's hosted inference API against the public,
 * pretrained COCO object-detection model (`coco/50` — no training required,
 * includes a `person` class). This is the "Hosted API — you provide keys"
 * path chosen for CV compute; see the deliverables report for the full
 * vendor comparison and pricing (free tier: 15 credits/mo, 1 credit ≈
 * 1,000 single-frame inferences at time of writing).
 *
 * IMPORTANT — testing status: this project's build/dev environment has no
 * network path to roboflow.com (an infrastructure-level egress allowlist,
 * confirmed via the proxy's own status endpoint — not a code issue), so
 * this HTTP call is written against Roboflow's long-documented classic
 * Hosted Inference API contract but has NOT been exercised against a live
 * response in this environment. It needs a first real run — ROBOFLOW_HOST
 * is overridable in case the classic endpoint has moved by the time you
 * run this. See the deliverables report's "known limitations" section.
 */

const DEFAULT_HOST = "https://detect.roboflow.com";
const DEFAULT_MODEL = "coco/50";
const PERSON_CLASS_NAMES = new Set(["person"]);

interface RoboflowPrediction {
  x: number; // center, pixels
  y: number; // center, pixels
  width: number; // pixels
  height: number; // pixels
  confidence: number;
  class: string;
  class_id?: number;
}

interface RoboflowResponse {
  predictions: RoboflowPrediction[];
  image?: { width: number; height: number };
}

export class RoboflowConfigError extends Error {}
export class RoboflowApiError extends Error {}

function requireApiKey(): string {
  const key = process.env.ROBOFLOW_API_KEY;
  if (!key) {
    throw new RoboflowConfigError(
      "ROBOFLOW_API_KEY is not set. Add it to .env.local — see .env.example."
    );
  }
  return key;
}

export async function detectPlayersViaRoboflow(
  frame: { path: string; timestampSeconds: number },
  opts: { frameWidthPx: number; frameHeightPx: number; confidenceThreshold?: number }
): Promise<PlayerDetection[]> {
  const apiKey = requireApiKey();
  const host = process.env.ROBOFLOW_HOST || DEFAULT_HOST;
  const model = process.env.ROBOFLOW_MODEL_ID || DEFAULT_MODEL;
  const confidence = Math.round((opts.confidenceThreshold ?? 0.35) * 100);

  const imageBuffer = await fs.readFile(frame.path);
  const base64Image = imageBuffer.toString("base64");

  const url = `${host}/${model}?api_key=${encodeURIComponent(apiKey)}&confidence=${confidence}&overlap=30`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: base64Image,
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new RoboflowApiError(
      `Roboflow inference request failed (${response.status}): ${bodyText.slice(0, 500)}`
    );
  }

  const data = (await response.json()) as RoboflowResponse;
  const imageWidth = data.image?.width ?? opts.frameWidthPx;
  const imageHeight = data.image?.height ?? opts.frameHeightPx;

  const detections: PlayerDetection[] = [];
  for (const pred of data.predictions ?? []) {
    if (!PERSON_CLASS_NAMES.has(pred.class)) continue;

    const boxImageNorm: BoundingBoxNorm = {
      x: (pred.x - pred.width / 2) / imageWidth,
      y: (pred.y - pred.height / 2) / imageHeight,
      width: pred.width / imageWidth,
      height: pred.height / imageHeight,
    };

    detections.push({
      confidence: pred.confidence,
      boxImageNorm,
      timestampSeconds: frame.timestampSeconds,
    });
  }

  return detections;
}
