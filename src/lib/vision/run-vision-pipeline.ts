import { getPhase2VisionProvider } from "./provider-v2";
import { analyzeMovementWithCalibration } from "./provider-v2";
import { hitsToUnknownShotEvents, detectFootworkFoundation } from "./events";
import { computeAppearanceSignaturesViaPython, detectBallViaPython, BallModelNotConfiguredError, ballModelConfigured } from "./cv-scripts";
import { buildBallTrack, detectBounces, detectHits, sliceTrack, type BallDetection, type BallHit, type BallTrackPoint, type BallTrackStats } from "./ball";
import { classifyRally, courtFrameFor, sideOf as courtSideOf, type Shot } from "./shots";
import { transformToCourtCoordinates } from "./court";
import { clusterRalliesFromHits, HIT_CLUSTER_PARAMS } from "./rallies";
import type {
  AnalysisEvent,
  BoundingBoxNorm,
  CourtCalibration,
  FrameDetectionSet,
  PlayerMovementMetrics,
  PlayerPoseFrame,
  PlayerTrack,
  QualityDiagnostics,
} from "./phase2-types";

export interface VisionPipelineInput {
  videoPath: string;
  frames: Array<{ path: string; timestampSeconds: number }>;
  frameWidthPx: number;
  frameHeightPx: number;
  visionFps: number;
  videoDurationSeconds: number;
}

export interface VisionPipelineOutput {
  providerName: string;
  courtCalibration: CourtCalibration;
  perFrameDetections: FrameDetectionSet[];
  tracks: PlayerTrack[];
  poses: PlayerPoseFrame[];
  movement: PlayerMovementMetrics[];
  footwork: ReturnType<typeof detectFootworkFoundation>[];
  events: AnalysisEvent[];
  /** Ball track (image-normalized) and per-contact shot classification — empty when no ball model is configured. */
  ballTrack: {
    points: BallTrackPoint[];
    stats: BallTrackStats | null;
    diagnostics: Record<string, unknown>;
    /**
     * Every per-frame candidate the model returned, before buildBallTrack's
     * gating/tracking collapses them to one point per frame. Kept so the
     * tracker's constants (GATE_BASE, GATE_PER_SPEED, MAX_GAP_FRAMES,
     * REACQUIRE_MIN_CONF in ball.ts) can be re-tuned offline against real
     * footage later, without paying for another model run just to get the
     * raw candidates back -- see scripts/run-shots.ts, which persists this
     * to ball.json. Empty when no ball model is configured.
     */
    rawDetections: BallDetection[];
  };
  shots: Shot[];
  quality: QualityDiagnostics;
}

/**
 * The real Phase 2 CV pipeline, independent of how it's invoked (the Next.js
 * background job in pipeline-v2.ts, or the standalone benchmark harness in
 * scripts/run-benchmark.mjs both call this). Deliberately has no knowledge
 * of Supabase/DB — it just does the CV work and returns structured data,
 * which keeps it testable without a live database connection (relevant
 * here: this dev environment has no network path to Supabase either — see
 * the deliverables report).
 */
/** Stage progress on stderr — the pipeline can run for many minutes and silence reads as "stuck". */
function log(msg: string) {
  console.error(`[vision ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

export async function runVisionPipeline(input: VisionPipelineInput): Promise<VisionPipelineOutput> {
  const provider = getPhase2VisionProvider(input.frameWidthPx, input.frameHeightPx);
  const knownLimitations: string[] = [];
  const t0 = Date.now();
  log(`provider=${provider.name} · ${input.frames.length} frames at ${input.visionFps} fps · ${input.frameWidthPx}x${input.frameHeightPx}`);

  // Court geometry doesn't change within a single fixed-camera clip, so
  // calibration only needs to run once — but which single frame it runs on
  // matters a lot in practice: a player briefly occluding the court paint,
  // motion blur, or a moment where the color mask catches a neighboring
  // court can drop confidence to 0 on one frame while a frame a few
  // seconds away calibrates fine. Try several evenly-spaced candidates and
  // keep the highest-confidence result, rather than gambling on one frame.
  const candidateIndices = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95].map((f) => Math.floor(input.frames.length * f));
  let courtCalibration: Awaited<ReturnType<typeof provider.detectCourt>> | null = null;
  for (const idx of candidateIndices) {
    const frame = input.frames[idx];
    if (!frame) continue;
    const candidate = await provider.detectCourt(frame);
    if (!courtCalibration || candidate.confidence > courtCalibration.confidence) {
      courtCalibration = candidate;
    }
    if (courtCalibration.confidence >= 0.8) break; // good enough, stop spending calls
  }
  courtCalibration ??= await provider.detectCourt(input.frames[0]);
  log(`court calibration confidence ${courtCalibration.confidence}${courtCalibration.quadKind ? ` (${courtCalibration.quadKind})` : ""}`);
  if (courtCalibration.confidence === 0) {
    knownLimitations.push("Court calibration failed on every candidate frame tried — movement metrics will be null for every player.");
  }

  // Player detection, one Roboflow call per sampled frame. Sequential
  // (not Promise.all) on purpose — a free-tier hosted API can rate-limit
  // bursts, and this keeps VISION_FPS the actual throttle on call volume.
  const perFrameDetections: FrameDetectionSet[] = [];
  log(`detecting players (${input.frames.length} frames, one call each)…`);
  for (const [fi, frame] of input.frames.entries()) {
    if (fi > 0 && fi % 100 === 0) log(`  players: ${fi}/${input.frames.length} frames`);
    const players = await provider.detectPlayers(frame);
    perFrameDetections.push({ timestampSeconds: frame.timestampSeconds, framePath: frame.path, players });
  }

  // Appearance signatures (a color cue for re-identifying a lost track, see
  // tracker.ts) in ONE batched Python process across every frame, instead
  // of one process per frame -- this is classical CV with no model to
  // load, so a per-frame process was mostly paying Python startup/import
  // cost over and over. Never lets a Python/OpenCV failure here fail the
  // whole pipeline -- the tracker works fine without signatures, just
  // without re-identification.
  let appearanceSignatureFailures = 0;
  const framesWithPlayers = perFrameDetections.filter((f) => f.players.length > 0);
  if (framesWithPlayers.length > 0) {
    try {
      const signaturesByPath = await computeAppearanceSignaturesViaPython(
        framesWithPlayers.map((f) => ({ imagePath: f.framePath, boxes: f.players.map((p) => p.boxImageNorm) }))
      );
      for (const f of framesWithPlayers) {
        const signatures = signaturesByPath.get(f.framePath);
        if (!signatures) {
          appearanceSignatureFailures += 1;
          continue;
        }
        f.players = f.players.map((p, i) => ({ ...p, appearanceSignature: signatures[i] ?? null }));
      }
    } catch {
      appearanceSignatureFailures = framesWithPlayers.length;
    }
  }

  if (appearanceSignatureFailures > 0) {
    knownLimitations.push(
      `Appearance-signature computation failed on ${appearanceSignatureFailures} of ${input.frames.length} sampled frame(s); track re-identification is degraded for those frames.`
    );
  }

  // With a calibration, a detection's feet tell us (a) whether it's on the
  // court at all — spectators, benches and the next court over are the
  // bulk of "5.6 people per frame" in a real gym — and (b) which side of
  // the net it's on, which the tracker uses to stop identities swapping
  // across the net.
  const courtFrame = courtFrameFor(courtCalibration.quadKind);
  const feetCourt = (box: BoundingBoxNorm) =>
    courtCalibration.confidence > 0 ? transformToCourtCoordinates(box, courtCalibration, input.frameWidthPx, input.frameHeightPx) : null;
  const onCourt = (box: BoundingBoxNorm): boolean => {
    const c = feetCourt(box);
    if (!c) return true; // no calibration: keep everyone
    const farBaseline = courtFrame.netY - courtFrame.halfLength;
    const nearBaseline = courtFrame.netY + courtFrame.halfLength;
    const run = 0.6 * courtFrame.halfLength; // generous run-off behind each baseline and beside the court
    return c.x > -0.45 && c.x < 1.45 && c.y > farBaseline - run * 1.5 && c.y < nearBaseline + run;
  };
  const sideOf = (box: BoundingBoxNorm): "near" | "far" | null => {
    const c = feetCourt(box);
    return c ? courtSideOf(courtFrame, c.y) : null;
  };
  let offCourtDropped = 0;
  const filteredDetections: FrameDetectionSet[] = perFrameDetections.map((f) => {
    const players = f.players.filter((p) => {
      const keep = onCourt(p.boxImageNorm);
      if (!keep) offCourtDropped += 1;
      return keep;
    });
    return { ...f, players };
  });
  if (offCourtDropped > 0) log(`dropped ${offCourtDropped} off-court detections (spectators, other courts)`);

  const rawTracks = await provider.trackPlayers(filteredDetections, { sideOf });
  // trackPlayers() has no calibration context of its own, so it always
  // leaves courtPosition null -- backfill it here using the same
  // homography (feetCourt) already computed above for on-court filtering
  // and side assignment. Every downstream consumer (rally motion
  // clustering, movement metrics, coaching facts) prefers real court-
  // meters distance over the cruder image-space-per-second fallback
  // whenever calibration succeeded; when it did not, feetCourt already
  // returns null and behavior is unchanged.
  const tracks: PlayerTrack[] = rawTracks.map((t) => ({
    ...t,
    points: t.points.map((p) => ({ ...p, courtPosition: p.courtPosition ?? feetCourt(p.boxImageNorm) })),
  }));
  log(`tracking: ${tracks.length} player track(s)`);
  if (tracks.length === 0) {
    knownLimitations.push("No player tracks survived (need >=2 sampled detections to count as a track).");
  } else if (tracks.length < 4) {
    knownLimitations.push(`Only ${tracks.length} stable player track(s) found; expected up to 4 for doubles.`);
  }

  // Pose per sampled frame, matched back to tracks by box overlap.
  let poses: PlayerPoseFrame[] = [];
  log("estimating pose…");
  try {
    const { estimatePosesForFrames } = await import("./pose");
    poses = await estimatePosesForFrames(input.frames, tracks);
  } catch (err) {
    knownLimitations.push(`Pose estimation failed: ${(err as Error).message}`);
  }

  const movement = tracks.map((t) =>
    analyzeMovementWithCalibration(t, courtCalibration, input.frameWidthPx, input.frameHeightPx)
  );
  const footwork = tracks.map((t) => detectFootworkFoundation(t));

  const events: AnalysisEvent[] = [];
  for (const fw of footwork) {
    for (const candidate of fw.possibleSplitSteps) {
      events.push({
        type: "possible_split_step",
        timestampSeconds: candidate.timestampSeconds,
        playerId: fw.playerId,
        confidence: candidate.confidence,
        source: "movement-heuristic",
      });
    }
  }

  // Ball, rallies and shots. Rally boundaries now come from the ball
  // track itself (clusterRalliesFromHits, rallies.ts): a paddle hit,
  // detected purely from the ball's own trajectory, is the evidence a
  // rally is live -- player movement between points turned out not to be
  // a reliable "nothing's happening" signal (players routinely walk
  // briskly for several seconds between points), so it's no longer used
  // to find boundaries at all. No audio signal is used anywhere in this
  // app either. Skipped entirely -- and said so -- when no ball model is
  // configured, or when ball detection fails; there is no fallback that
  // finds rallies without ball data, so that clip gets NO rallies and NO
  // shots, honestly, rather than a guessed boundary from something else.
  let ballTrack: VisionPipelineOutput["ballTrack"] = { points: [], stats: null, diagnostics: {}, rawDetections: [] };
  let shots: Shot[] = [];
  if (!ballModelConfigured()) {
    knownLimitations.push(
      "No ball detector configured (BALL_MODEL_ID) — rally boundaries come from ball hits, not player movement or audio, so no rallies could be found at all and no shot types were classified."
    );
  } else {
    try {
      // Ball presence/movement is the primary signal for "is a rally
      // happening", not player speed (see clusterRalliesFromHits in
      // rallies.ts) -- player movement between points turned out not to
      // be a reliable "nothing's happening" signal (players routinely
      // walk briskly for several seconds to retrieve the ball or
      // reposition between points), so this scans the ball across the
      // WHOLE clip up front rather than only inside player-motion-
      // derived windows like before. Costs more ball-detector calls per
      // clip than the old windowed approach, which is the trade Ky
      // approved after seeing it roughly doubled worst-clip rally F1 in
      // testing (0.167 -> 0.348 across the 3 labeled clips).
      log(`detecting the ball across the full ${input.videoDurationSeconds.toFixed(0)}s clip — first run downloads the model…`);
      const raw = await detectBallViaPython(input.videoPath, [[0, input.videoDurationSeconds]]);
      const built = buildBallTrack(raw.detections, raw.fps, raw.framesProcessed);
      log(`ball: seen in ${Math.round(built.stats.coverage * 100)}% of ${built.stats.framesProcessed} frames (${JSON.stringify(raw.diagnostics.modelSource)})`);
      ballTrack = { points: built.points, stats: built.stats, diagnostics: raw.diagnostics, rawDetections: raw.detections };
      if (built.stats.coverage < 0.15) {
        knownLimitations.push(
          `The ball was found in only ${Math.round(built.stats.coverage * 100)}% of frames — rally boundaries and shot types below are low-confidence; a camera with the whole court in frame and a ball model trained on this camera angle improves this.`
        );
      }
      const ctx = {
        calibration: courtCalibration,
        frame: courtFrameFor(courtCalibration.quadKind),
        frameWidthPx: input.frameWidthPx,
        frameHeightPx: input.frameHeightPx,
        playerTracks: tracks,
      };
      const overheadAt = (playerId: string, t: number): boolean | null => {
        let best: PlayerPoseFrame | null = null;
        let bestDt = 0.3;
        for (const p of poses) {
          if (p.playerId !== playerId) continue;
          const dt = Math.abs(p.timestampSeconds - t);
          if (dt < bestDt) {
            bestDt = dt;
            best = p;
          }
        }
        if (!best) return null;
        const kp = (name: string) => best!.keypoints.find((k) => k.name === name);
        const ls = kp("left_shoulder"), rs = kp("right_shoulder"), lw = kp("left_wrist"), rw = kp("right_wrist");
        const shoulderY = [ls, rs].filter((k) => k && k.yNorm !== null && (k.confidence ?? 0) >= 0.3).map((k) => k!.yNorm!);
        const wristY = [lw, rw].filter((k) => k && k.yNorm !== null && (k.confidence ?? 0) >= 0.3).map((k) => k!.yNorm!);
        if (shoulderY.length === 0 || wristY.length === 0) return null;
        return Math.min(...wristY) < Math.min(...shoulderY) - 0.03; // a wrist clearly above the shoulders
      };
      // Scan the whole track once for hits, then group hits directly
      // into rallies -- a hit is the strongest evidence a rally is
      // actually live, so it decides the boundary, not the other way
      // around.
      const allHitsWide = detectHits(built.points, tracks, overheadAt);
      const rallies = clusterRalliesFromHits(allHitsWide.map((h) => h.t), input.videoDurationSeconds, HIT_CLUSTER_PARAMS);
      if (rallies.length === 0) {
        knownLimitations.push("No ball hits were detected sharply enough to identify any rallies — shot types were not classified.");
      }
      log(`segmented ${rallies.length} rallies from ${allHitsWide.length} ball hits`);
      const allHits: BallHit[] = [];
      for (const r of rallies) {
        // Re-detect scoped to the reported window (+0.3s pad) so hit
        // indices near the edge have the same neighbor context detectHits
        // expects, rather than reusing the global scan's edge-of-array
        // results directly.
        const pts = sliceTrack(built.points, r.startS - 0.3, r.endS + 0.3);
        const hits = detectHits(pts, tracks, overheadAt);
        const bounces = detectBounces(pts, hits.map((h) => h.t));
        allHits.push(...hits);
        shots.push(...classifyRally({ rallyIdx: r.idx, startS: r.startS, endS: r.endS, hits, bounces, ballPoints: pts }, ctx));
      }
      events.push(...hitsToUnknownShotEvents(allHits));
    } catch (err) {
      if (err instanceof BallModelNotConfiguredError) {
        knownLimitations.push(err.message);
      } else {
        knownLimitations.push(`Ball detection failed, so shot types were not classified: ${(err as Error).message.split("\n")[0]}`);
      }
      shots = [];
    }
  }

  events.sort((a, b) => a.timestampSeconds - b.timestampSeconds);
  const shotEventCount = events.filter((e) => e.type === "unknown_shot").length;
  log(`shots: ${shots.length} classified (${shotEventCount} ball-detected contacts) · done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  const playerCounts = filteredDetections.map((f) => f.players.length);
  const quality: QualityDiagnostics = {
    videoDurationSeconds: input.videoDurationSeconds,
    visionFps: input.visionFps,
    framesSampled: input.frames.length,
    courtCalibrationConfidence: courtCalibration.confidence,
    playersDetectedPerFrame: {
      min: playerCounts.length ? Math.min(...playerCounts) : 0,
      max: playerCounts.length ? Math.max(...playerCounts) : 0,
      mean: playerCounts.length ? Math.round((playerCounts.reduce((a, b) => a + b, 0) / playerCounts.length) * 100) / 100 : 0,
    },
    tracksProduced: tracks.length,
    tracksWithStableId: tracks.filter((t) => t.points.length >= input.frames.length * 0.3).length,
    poseFramesAttempted: input.frames.length,
    poseFramesSucceeded: new Set(poses.map((p) => p.timestampSeconds)).size,
    shotEventCount,
    ballCoverage: ballTrack.stats?.coverage ?? null,
    shotsClassified: shots.filter((s) => s.type !== "unknown").length,
    knownLimitations,
  };

  return {
    providerName: provider.name,
    courtCalibration,
    perFrameDetections,
    tracks,
    poses,
    movement,
    footwork,
    events,
    ballTrack,
    shots,
    quality,
  };
}
