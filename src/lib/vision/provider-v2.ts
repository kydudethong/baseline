import { detectCourt, transformToCourtCoordinates as transformImpl } from "./court";
import { detectPlayersViaRoboflow } from "./roboflow-provider";
import { detectPlayersViaPython } from "./cv-scripts";
import { trackPlayersByIoU } from "./tracker";
import { estimatePosesForFrames } from "./pose";
import { analyzeMovement as analyzeMovementImpl } from "./movement";
import type {
  BoundingBoxNorm,
  CourtCalibration,
  FrameDetectionSet,
  Phase2VisionProvider,
  PlayerDetection,
  PlayerMovementMetrics,
  PlayerPoseFrame,
  PlayerTrack,
} from "./phase2-types";

/**
 * Real Phase 2 provider: Roboflow (hosted, player detection) + a local IoU
 * tracker + local YOLOv8n-pose (pose) + classical-CV court detection +
 * homography-based court transform + derived movement metrics. See
 * roboflow-provider.ts and the deliverables report for why each piece is
 * built the way it is, and for what has/hasn't been exercised against a
 * live network call in this environment.
 */
export class RoboflowPhase2VisionProvider implements Phase2VisionProvider {
  readonly name = "roboflow+local-cv";

  constructor(private readonly frameWidthPx: number, private readonly frameHeightPx: number) {}

  async detectCourt(frame: { path: string; timestampSeconds: number }): Promise<CourtCalibration> {
    return detectCourt(frame);
  }

  async detectPlayers(frame: { path: string; timestampSeconds: number }): Promise<PlayerDetection[]> {
    // Kept for the hosted path and for any caller that still wants one frame
    // at a time. The local detector is batched instead -- see
    // detectPlayersBatch, which is what the pipeline uses.
    return detectPlayersViaRoboflow(frame, {
      frameWidthPx: this.frameWidthPx,
      frameHeightPx: this.frameHeightPx,
    });
  }

  /** Whole clip in one local Python process; falls back to per-frame hosted calls. */
  async detectPlayersBatch(
    frames: Array<{ path: string; timestampSeconds: number }>
  ): Promise<Map<string, PlayerDetection[]>> {
    const byPath = await detectPlayersViaPython(frames.map((f) => f.path));
    const out = new Map<string, PlayerDetection[]>();
    for (const f of frames) {
      const found = byPath.get(f.path) ?? [];
      out.set(f.path, found.map((p) => ({
        boxImageNorm: p.boxImageNorm,
        confidence: p.confidence,
        timestampSeconds: f.timestampSeconds,
        appearanceSignature: null,
      })));
    }
    return out;
  }

  async trackPlayers(perFrame: FrameDetectionSet[], opts?: Parameters<typeof trackPlayersByIoU>[1]): Promise<PlayerTrack[]> {
    return trackPlayersByIoU(perFrame, opts);
  }

  async estimatePose(
    frame: { path: string; timestampSeconds: number },
    tracks: PlayerTrack[]
  ): Promise<PlayerPoseFrame[]> {
    return estimatePosesForFrames([frame], tracks);
  }

  transformToCourtCoordinates(
    boxImageNorm: BoundingBoxNorm,
    calibration: CourtCalibration
  ): { x: number; y: number } | null {
    return transformImpl(boxImageNorm, calibration, this.frameWidthPx, this.frameHeightPx);
  }

  analyzeMovement(_track: PlayerTrack): PlayerMovementMetrics {
    throw new Error(
      "analyzeMovement() needs a CourtCalibration — call the movement.ts analyzeMovement(track, calibration, w, h) helper directly from the pipeline instead of through this interface method. Kept on the interface to match the spec's named seam; pipeline-v2.ts is the real caller."
    );
  }
}

/**
 * Clearly-labeled synthetic Phase 2 provider for local development without
 * any CV credentials — mirrors MockVisionProvider's philosophy (see
 * mock-provider.ts): every value is synthetic, every method name matches
 * the real provider, `name` unconditionally identifies it as mock so
 * nothing downstream can present this as a real result.
 */
export class MockPhase2VisionProvider implements Phase2VisionProvider {
  readonly name = "mock";

  async detectCourt(frame: { path: string; timestampSeconds: number }): Promise<CourtCalibration> {
    return {
      method: "mock",
      confidence: 0,
      cornersImagePx: null,
      quadKind: null,
      frameTimestampSeconds: frame.timestampSeconds,
      diagnostics: { note: "mock provider never claims a real calibration" },
    };
  }

  async detectPlayers(frame: { path: string; timestampSeconds: number }): Promise<PlayerDetection[]> {
    const wobble = Math.sin(frame.timestampSeconds) * 0.03;
    return [0.2, 0.4, 0.6, 0.8].map((baseX) => ({
      confidence: 0.5,
      boxImageNorm: { x: baseX + wobble, y: 0.55, width: 0.08, height: 0.28 },
      timestampSeconds: frame.timestampSeconds,
    }));
  }

  async trackPlayers(perFrame: FrameDetectionSet[], opts?: Parameters<typeof trackPlayersByIoU>[1]): Promise<PlayerTrack[]> {
    return trackPlayersByIoU(perFrame, opts);
  }

  async estimatePose(): Promise<PlayerPoseFrame[]> {
    return [];
  }

  transformToCourtCoordinates(): { x: number; y: number } | null {
    return null; // mock calibration always fails — never fabricate a court position
  }

  analyzeMovement(track: PlayerTrack): PlayerMovementMetrics {
    return {
      playerId: track.playerId,
      distanceCoveredCourtUnits: null,
      distanceCoveredMetersApprox: null,
      averageSpeedCourtUnitsPerSecond: null,
      maxSpeedCourtUnitsPerSecond: null,
      courtCoverageBounds: null,
      samples: [],
      transformedSampleCount: 0,
      totalSampleCount: track.points.length,
    };
  }
}

export { analyzeMovementImpl as analyzeMovementWithCalibration };

export function getPhase2VisionProvider(frameWidthPx: number, frameHeightPx: number): Phase2VisionProvider {
  const kind = process.env.VISION_PROVIDER || "mock";
  if (kind === "roboflow" || kind === "local") {
    return new RoboflowPhase2VisionProvider(frameWidthPx, frameHeightPx);
  }
  return new MockPhase2VisionProvider();
}

/**
 * Detect people locally unless explicitly told to use the hosted API.
 *
 * Local is the default because the hosted model was `coco/50` -- a public,
 * pretrained COCO detector. Nothing about it was specific to this app, and
 * the only class ever read was `person`, which yolov8n.pt gives for free and
 * at a higher input resolution. Set PLAYER_DETECTION=roboflow to go back.
 */
export function playerDetectionIsLocal(): boolean {
  return (process.env.PLAYER_DETECTION || "local").toLowerCase() !== "roboflow";
}
