import type {
  BoundingBox,
  DetectedObject,
  FrameDetections,
  ObjectTrack,
  VisionInput,
  VisionProvider,
} from "./types";

/**
 * Deterministic placeholder CV provider. It does not look at pixels — it
 * generates plausible-shaped, clearly-labeled fake detections so the rest of
 * the app (storage, DB, UI) can be built against a stable interface before
 * `RoboflowVisionProvider` exists.
 *
 * IMPORTANT: every value this returns is synthetic. `source` is always
 * `"mock"` so nothing downstream can present this as a real result — see
 * AnalysisEngine, which refuses to relabel it.
 */
export class MockVisionProvider implements VisionProvider {
  readonly name = "mock";

  async analyzeFrame(frame: { path: string; timestampSeconds: number }): Promise<FrameDetections> {
    return {
      timestampSeconds: frame.timestampSeconds,
      objects: syntheticObjectsFor(frame.timestampSeconds),
    };
  }

  async detectObjects(input: VisionInput): Promise<FrameDetections[]> {
    return input.frames.map((frame) => ({
      timestampSeconds: frame.timestampSeconds,
      objects: syntheticObjectsFor(frame.timestampSeconds),
    }));
  }

  async trackObjects(perFrame: FrameDetections[]): Promise<ObjectTrack[]> {
    // Naively group by class, assigning one synthetic track per class —
    // real tracking (e.g. ByteTrack/DeepSORT inside Roboflow) will replace
    // this with actual identity association across frames.
    const byClass = new Map<string, ObjectTrack>();

    for (const frame of perFrame) {
      for (const object of frame.objects) {
        const key = `${object.class}-1`;
        if (!byClass.has(key)) {
          byClass.set(key, { trackId: key, class: object.class, points: [] });
        }
        byClass.get(key)!.points.push({
          timestampSeconds: frame.timestampSeconds,
          box: object.box,
          confidence: object.confidence,
        });
      }
    }

    return Array.from(byClass.values());
  }
}

function syntheticObjectsFor(timestampSeconds: number): DetectedObject[] {
  // Simple deterministic motion so repeated calls produce varying-but-stable
  // output, making it obvious in the UI that this is generated, not real.
  const wobble = Math.sin(timestampSeconds) * 0.05;

  const player = (baseX: number): DetectedObject => ({
    class: "player",
    confidence: 0.5,
    box: box(baseX + wobble, 0.55, 0.12, 0.3),
  });

  const ball: DetectedObject = {
    class: "ball",
    confidence: 0.4,
    box: box(0.5 + wobble * 2, 0.4, 0.02, 0.02),
  };

  return [player(0.25), player(0.7), ball];
}

function box(x: number, y: number, width: number, height: number): BoundingBox {
  return {
    x: clamp01(x),
    y: clamp01(y),
    width,
    height,
  };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
