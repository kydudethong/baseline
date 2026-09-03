/**
 * The CV abstraction boundary. Nothing in this file talks to a real vision
 * model yet — `MockVisionProvider` (mock-provider.ts) is the only
 * implementation in Phase 1. A future `RoboflowVisionProvider` implements
 * the same interface, so the rest of the app never needs to change.
 */

/** What VideoProcessor.prepareForVision() hands to a VisionProvider. */
export interface VisionInput {
  videoDurationSeconds: number;
  width: number | null;
  height: number | null;
  /** Sampled frames, evenly spaced across the video. */
  frames: Array<{ path: string; timestampSeconds: number }>;
}

export interface BoundingBox {
  /** 0–1, normalised to frame width/height so it's resolution-independent. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DetectedObjectClass = "player" | "ball" | "paddle" | "net";

export interface DetectedObject {
  class: DetectedObjectClass;
  confidence: number;
  box: BoundingBox;
}

export interface FrameDetections {
  timestampSeconds: number;
  objects: DetectedObject[];
}

/** A tracked object's position over time — the output of trackObjects(). */
export interface ObjectTrack {
  trackId: string;
  class: DetectedObjectClass;
  points: Array<{ timestampSeconds: number; box: BoundingBox; confidence: number }>;
}

export interface VisionAnalysis {
  /** 'mock' in Phase 1. A real provider sets its own identifier here so
   *  downstream consumers (and the UI) never mistake one for the other. */
  source: string;
  perFrame: FrameDetections[];
  tracks: ObjectTrack[];
}

/**
 * Computer-vision provider abstraction. `RoboflowVisionProvider` (future)
 * implements this against a real Roboflow workflow; `MockVisionProvider`
 * (present) returns clearly-labeled placeholder data so the rest of the
 * pipeline can be built and tested today.
 */
export interface VisionProvider {
  readonly name: string;

  /** Object detection on a single frame. */
  analyzeFrame(frame: { path: string; timestampSeconds: number }): Promise<FrameDetections>;

  /** Object detection across every sampled frame. */
  detectObjects(input: VisionInput): Promise<FrameDetections[]>;

  /** Links per-frame detections into tracks (same player/ball over time). */
  trackObjects(perFrame: FrameDetections[]): Promise<ObjectTrack[]>;
}
