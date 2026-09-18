/**
 * Phase 2 CV types — the richer seam requested for the real pipeline:
 * detectCourt / detectPlayers / trackPlayers / estimatePose /
 * transformToCourtCoordinates / analyzeMovement.
 *
 * This sits alongside (does not replace) the Phase 1 VisionProvider in
 * ./types.ts (analyzeFrame/detectObjects/trackObjects), which the mock
 * pipeline still uses. Phase2VisionProvider is the real seam;
 * MockPhase2VisionProvider mirrors it with clearly-labeled synthetic data
 * for local development without CV credentials.
 */
import type { BuildSignature } from "./build-signature";


export interface BoundingBoxNorm {
  /** 0-1, normalised to frame width/height, top-left origin. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CourtCorners {
  topLeft: [number, number];
  topRight: [number, number];
  bottomLeft: [number, number];
  bottomRight: [number, number];
}

export interface CourtCalibration {
  /**
   * How this calibration was produced. Never silently swapped for a fake one.
   *
   * "not-marked" means nobody told us where the court is and nothing tried to
   * guess -- distinct from a detector that ran and failed, which is why it is
   * its own value rather than a zero-confidence "manual".
   *
   * "classical-cv-hsv-contour" and "rally_seg-classical" are no longer
   * produced: both automatic detectors were removed (see run-vision-pipeline).
   * They stay in the union because analyses recorded before that still carry
   * them, and reading old rows must not become a type error.
   */
  method: "classical-cv-hsv-contour" | "rally_seg-classical" | "manual" | "mock" | "not-marked";
  /** 0 means "could not calibrate" — corners will be null in that case. */
  confidence: number;
  /** Pixel coordinates in the source frame used for calibration. */
  cornersImagePx: CourtCorners | null;
  /**
   * Which physical rectangle the quad covers. Everything that turns court
   * units into feet, zones or sides reads this — see shots.ts courtFrameFor().
   *   near-inplay  two-tone court: baseline -> kitchen line (20 x 15 ft)
   *   near-half    baseline -> net (20 x 22 ft)
   *   full         baseline -> far baseline (20 x 44 ft)
   * Null for a failed or mock calibration.
   */
  quadKind: "near-inplay" | "near-half" | "full" | null;
  frameTimestampSeconds: number;
  diagnostics: Record<string, unknown>;
}

/** Mean colour of one sampled region: hue in degrees 0-360 (circular), s/v 0-1. */
export interface ColourBand {
  h: number;
  s: number;
  v: number;
}

/**
 * What a player looks like, in three horizontal bands.
 *
 * ONE BAND WAS NOT ENOUGH, and the case it failed on is the common one. This
 * used to be a single mean over the torso -- the shirt -- on the reasoning
 * that shirt colour almost always separates two doubles partners. Rec
 * pickleball partners in matching kit break that completely: the signal does
 * not weaken, it vanishes, leaving geometry to handle two people standing
 * close together on the same side of the net, which is the exact situation
 * geometry is worst at.
 *
 * Head and legs are sampled too because they are what still differs: hair and
 * skin at the top, shorts, socks and shoes at the bottom. Any band may be null
 * when it could not be sampled; the comparison skips those rather than
 * discarding the whole signature.
 */
export interface AppearanceSignature {
  head: ColourBand | null;
  torso: ColourBand | null;
  legs: ColourBand | null;
}

export interface PlayerDetection {
  confidence: number;
  boxImageNorm: BoundingBoxNorm;
  timestampSeconds: number;
  /**
   * Optional cheap color cue (mean HSV of the torso region), used only to
   * help the tracker re-identify a track after a long gap. Absent when the
   * signature couldn't be computed (e.g. the appearance script failed) —
   * the tracker falls back to its non-re-id behavior in that case, so this
   * is always safe to omit.
   */
  appearanceSignature?: AppearanceSignature | null;
  /**
   * Body proportions from this detection's own keypoints — an identity cue
   * that clothing cannot change. See build-signature.ts. Absent when pose was
   * not run, or when too little of the body was confidently seen.
   */
  buildSignature?: BuildSignature | null;
}

export interface FrameDetectionSet {
  timestampSeconds: number;
  framePath: string;
  players: PlayerDetection[];
}

export interface PlayerTrackPoint {
  timestampSeconds: number;
  boxImageNorm: BoundingBoxNorm;
  confidence: number;
  /** Set once transformToCourtCoordinates() has run; null pre-transform or if calibration failed. */
  courtPosition: { x: number; y: number } | null;
}

export interface PlayerTrack {
  /** Stable across the whole clip: "player_1".."player_4" in order of first appearance. */
  playerId: string;
  points: PlayerTrackPoint[];
}

export type CocoKeypointName =
  | "nose" | "left_eye" | "right_eye" | "left_ear" | "right_ear"
  | "left_shoulder" | "right_shoulder" | "left_elbow" | "right_elbow"
  | "left_wrist" | "right_wrist" | "left_hip" | "right_hip"
  | "left_knee" | "right_knee" | "left_ankle" | "right_ankle";

export interface PoseKeypoint {
  name: CocoKeypointName;
  xNorm: number | null;
  yNorm: number | null;
  confidence: number | null;
}

export interface PlayerPoseFrame {
  playerId: string;
  timestampSeconds: number;
  detectionConfidence: number | null;
  keypoints: PoseKeypoint[];
  modelSource: "yolov8n-pose" | "mock";
}

export interface MovementSample {
  timestampSeconds: number;
  courtX: number;
  courtY: number;
  /** null for the first sample of a track (no prior point to derive speed from). */
  speedCourtUnitsPerSecond: number | null;
}

export interface PlayerMovementMetrics {
  playerId: string;
  /** Everything below is null (not zero, not guessed) when court calibration failed for this clip. */
  distanceCoveredCourtUnits: number | null;
  distanceCoveredMetersApprox: number | null;
  averageSpeedCourtUnitsPerSecond: number | null;
  maxSpeedCourtUnitsPerSecond: number | null;
  courtCoverageBounds: { xMin: number; xMax: number; yMin: number; yMax: number } | null;
  samples: MovementSample[];
  /** How many of this player's tracked points actually had a valid court transform. */
  transformedSampleCount: number;
  totalSampleCount: number;
  /**
   * Movements excluded from the distance total, and why. Distance that skips
   * these is smaller than the truth; distance that included them was not a
   * distance at all -- one clip integrated a 42-second tracking hole as a
   * single sprint and reported 23.9 m/s. Reporting the exclusions is what
   * keeps the smaller number honest rather than merely quieter.
   */
  excludedSegments?: { acrossGaps: number; implausibleSpeed: number };
}

/** Measurable, not judged — no "good/bad footwork" claims, only numbers. */
export interface FootworkFoundationMetrics {
  playerId: string;
  /** Range of lateral (x) movement in normalized court units, if calibrated. */
  lateralRangeCourtUnits: number | null;
  /** Bounding-box height over time, normalized to frame height — a candidate signal for crouch/split-step, nothing more. */
  boxHeightSeries: Array<{ timestampSeconds: number; heightNorm: number }>;
  /** Local minima in box height (a crouch candidate) that also fall near a tracked position change — offered as a CANDIDATE event only. */
  possibleSplitSteps: Array<{ timestampSeconds: number; confidence: number }>;
}

export type AnalysisEventType = "unknown_shot" | "possible_split_step";

export interface AnalysisEvent {
  type: AnalysisEventType;
  timestampSeconds: number;
  playerId: string | null;
  confidence: number;
  source: "movement-heuristic" | "mock";
}

export interface QualityDiagnostics {
  videoDurationSeconds: number;
  /** Ball detections per processed frame, when a ball model ran; null when shots were skipped. */
  ballCoverage: number | null;
  shotsClassified: number;
  visionFps: number;
  framesSampled: number;
  courtCalibrationConfidence: number;
  playersDetectedPerFrame: { min: number; max: number; mean: number };
  tracksProduced: number;
  tracksWithStableId: number;
  poseFramesAttempted: number;
  poseFramesSucceeded: number;
  /** unknown_shot events found (ball-track direction-change detection, not audio). */
  shotEventCount: number;
  /**
   * Balls that crossed the net once and never came back — a serve into the
   * net, a putaway nobody returned. Not rallies, and deliberately not counted
   * as contacts, but a point was conceded each time and that is coachable in
   * a way no rally count is.
   */
  deadBallCount?: number;
  knownLimitations: string[];
}

export interface Phase2VisionProvider {
  readonly name: string;
  detectCourt(frame: { path: string; timestampSeconds: number }): Promise<CourtCalibration>;
  detectPlayers(frame: { path: string; timestampSeconds: number }): Promise<PlayerDetection[]>;
  trackPlayers(perFrame: FrameDetectionSet[], opts?: { sideOf?: (box: BoundingBoxNorm) => "near" | "far" | null }): Promise<PlayerTrack[]>;
  estimatePose(
    frame: { path: string; timestampSeconds: number },
    tracks: PlayerTrack[]
  ): Promise<PlayerPoseFrame[]>;
  transformToCourtCoordinates(
    boxImageNorm: BoundingBoxNorm,
    calibration: CourtCalibration
  ): { x: number; y: number } | null;
  analyzeMovement(track: PlayerTrack): PlayerMovementMetrics;
}
