import { detectCourt, transformToCourtCoordinates as transformImpl } from "./court";
import { detectPlayersViaRoboflow } from "./roboflow-provider";
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
    return detectPlayersViaRoboflow(frame, {
      frameWidthPx: this.frameWidthPx,
      frameHeightPx: this.frameHeightPx,
    });
  }

  async trackPlayers(perFrame: FrameDetectionSet[]): Promise<PlayerTrack[]> {
    return trackPlayersByIoU(perFrame);
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

  async trackPlayers(perFrame: FrameDetectionSet[]): Promise<PlayerTrack[]> {
    return trackPlayersByIoU(perFrame);
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
  if (kind === "roboflow") return new RoboflowPhase2VisionProvider(frameWidthPx, frameHeightPx);
  return new MockPhase2VisionProvider();
}
