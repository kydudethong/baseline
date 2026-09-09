import { getPhase2VisionProvider, playerDetectionIsLocal } from "./provider-v2";
import { analyzeMovementWithCalibration } from "./provider-v2";
import { hitsToUnknownShotEvents, detectFootworkFoundation } from "./events";
import { computeAppearanceSignaturesViaPython, detectAudioOnsetsViaPython, detectBallViaPython, BallModelNotConfiguredError, ballModelConfigured } from "./cv-scripts";
import { buildBallTrack, detectBounces, detectHits, inferHitsBetweenCrossings, IN_RALLY_HIT_PARAMS, mergeHits, STRICT_HIT_PARAMS, newHitScanStats, sliceTrack, type BallDetection, type BallHit, type BallTrackPoint, type BallTrackStats } from "./ball";
import { classifyRally, courtFrameFor, sideOf as courtSideOf, type Shot } from "./shots";
import type { AnalysisStage } from "@/lib/db/types";
import { SWING_WINDOW_S, measureSwing } from "./swing";
import { extendRalliesWhileLive, keepAliveEnabled } from "./rally-keepalive";
import { applyBounceRule, applyDoubleBounceRule, bounceRuleEnabled, classifyBetween } from "./ball-exchange";
import { AUDIO_GATE_PARAMS, audioContactsEnabled, confirmAudioContacts, newAudioGateStats, type PaddleObservation } from "./audio-contacts";
import { ballGatePolygonPx, calibrationFromSetup, courtForeshorteningAt, isPlausibleCourtQuad, playerGatePolygonPx, pointInPolygon, transformToCourtCoordinates } from "./court";
import { clusterRalliesFromHits, HIT_CLUSTER_PARAMS, type ClusteredRally } from "./rallies";
import { detectNetCrossings, netLineImagePx, netRalliesEnabled, segmentNetCrossings, sideOfNet, type NetBand, type NetCrossing } from "./rallies-net";
import { clusterRalliesFromContacts, contactRalliesEnabled } from "./rallies-contact";
import { debugRenderEnabled, renderDebugVideo } from "./debug-render";
import { paddleFromPoseEnabled, paddlesFromPoses } from "./paddle-from-pose";
import { rallySegEnabled, segmentRalliesViaRallySeg } from "./rally-seg";
import { describeError } from "@/lib/analysis/describe-error";
import { detectCourtViaRallySeg, rallySegCourtEnabled } from "./court-rally-seg";
import {
  matchTracksToSetup, setupCourtForRallySeg, rallySegOverridesForSetup,
  type PreAnalysisSetup,
} from "@/lib/db/setup";
import type {
  AnalysisEvent,
  BoundingBoxNorm,
  CourtCalibration,
  FrameDetectionSet,
  PlayerDetection,
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
  /** Used to name debug artefacts so the UI can find them. */
  debugId?: string;
  /** What the user marked before processing, if they did. */
  setup?: PreAnalysisSetup | null;
  /** Scratch directory for extra frames (pose bursts). Bursts are skipped without it. */
  tempDir?: string;
  /**
   * Called as the run enters each stage, so a UI can say what is happening
   * during a run that takes minutes.
   *
   * There is no percentage here on purpose. The pipeline does not know how far
   * through it is — ball detection alone varies with clip length, contact count
   * and how much the ball was visible — and a bar that invented one would be
   * the exact dishonesty this product is built against. Stages a user can tick
   * off are both truthful and more informative than a lying number.
   */
  onProgress?: (stage: AnalysisStage, message: string) => void;
}

/**
 * A rally as the SEGMENTER drew it, with the evidence behind the boundary.
 *
 * Persisted alongside the shots it cut, so `Shot.rallyIdx` is a valid key into
 * this array. It is deliberately NOT the same thing as coaching_rallies, which
 * the coaching pass re-derives later by re-clustering contact timestamps and
 * which disagrees on both numbering and count.
 */
export interface AnalysisRallyOutput {
  idx: number;
  startS: number;
  endS: number;
  source: "net-crossings" | "hit-clustering" | "contacts" | "rally_seg" | "unknown";
  /** Why the segmenter thinks it ended, where it knows. Null is honest. */
  endReason: string | null;
  contactCount: number;
  crossingCount: number | null;
  /** Seconds keep-alive added past the last crossing. 0 = ended on its own. */
  extendedSeconds: number;
  contacts: Array<{ t_s: number; side: "self" | "opponent" | "unknown"; confidence: number }>;
}

export interface VisionPipelineOutput {
  providerName: string;
  /** Track the user identified as themselves during setup, if they did. */
  selfPlayerId: string | null;
  courtCalibration: CourtCalibration;
  perFrameDetections: FrameDetectionSet[];
  tracks: PlayerTrack[];
  poses: PlayerPoseFrame[];
  movement: PlayerMovementMetrics[];
  footwork: ReturnType<typeof detectFootworkFoundation>[];
  events: AnalysisEvent[];
  /** Rally boundaries as the segmenter drew them, with the evidence behind each. */
  rallies: AnalysisRallyOutput[];
  /** Set when an annotated overlay was rendered, so the caller can record where it went. */
  debugVideoUrl: string | null;
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
  // Entering a stage is reported once, alongside the same line that already
  // went to stderr, so the browser and the terminal never disagree about where
  // the run is.
  const stage = (name: AnalysisStage, message: string) => {
    log(message);
    input.onProgress?.(name, message);
  };
  const provider = getPhase2VisionProvider(input.frameWidthPx, input.frameHeightPx);
  const knownLimitations: string[] = [];
  const t0 = Date.now();
  stage("preparing", `provider=${provider.name} · ${input.frames.length} frames at ${input.visionFps} fps · ${input.frameWidthPx}x${input.frameHeightPx}`);
  stage("court", "Finding the court");

  // Court geometry doesn't change within a single fixed-camera clip, so
  // calibration only needs to run once — but which single frame it runs on
  // matters a lot in practice: a player briefly occluding the court paint,
  // motion blur, or a moment where the color mask catches a neighboring
  // court can drop confidence to 0 on one frame while a frame a few
  // seconds away calibrates fine. Try several evenly-spaced candidates and
  // keep the highest-confidence result, rather than gambling on one frame.
  let courtCalibration: CourtCalibration | null = null;

  // 1. What the user marked by hand during setup. Four clicks on the painted
  //    lines beat anything either detector can fit, and nothing should ever
  //    silently overrule a person who looked at the frame.
  const marked = calibrationFromSetup(input.setup ?? null, input.frameWidthPx, input.frameHeightPx);
  if (marked) {
    courtCalibration = marked;
    log("court: using the corners you marked during setup");
  }

  // 2. rally_seg's classical fit. It searches quads over Hough-clustered line
  //    segments and scores each on the paint it explains *and* the regions it
  //    claims are blank, then takes the consensus across independently fitted
  //    frames. On low-tripod footage this app's own contour detector returns a
  //    ~60px sliver and calls it 0.777 confident; rally_seg lands within ~10px
  //    of hand-marked corners on the same clip.
  if (!courtCalibration && rallySegCourtEnabled()) {
    courtCalibration = await detectCourtViaRallySeg(
      input.videoPath, [input.frameWidthPx, input.frameHeightPx], (l) => log(`  court: ${l}`),
      rallySegOverridesForSetup(input.setup ?? null)
    );
    if (courtCalibration) {
      const d = courtCalibration.diagnostics as { agreement?: number };
      log(`court: rally_seg fitted (${courtCalibration.quadKind}), line support `
        + `${courtCalibration.confidence.toFixed(3)}, ${Math.round((d.agreement ?? 0) * 100)}% frame agreement`);
    }
  }

  // 3. This app's own detector. Court geometry doesn't change within a
  //    fixed-camera clip, but which frame it runs on matters: a player over
  //    the paint, motion blur, or a neighbouring court caught by the colour
  //    mask can drop confidence to 0 on one frame and not the next.
  if (!courtCalibration) {
    const candidateIndices = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95].map((f) => Math.floor(input.frames.length * f));
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
  }

  // Confidence is a detector's self-assessment; plausibility is a fact about
  // the quad. A geometrically impossible court is worse than none, because
  // every consumer treats a non-zero confidence as permission to measure.
  if (courtCalibration.confidence > 0
      && !isPlausibleCourtQuad(courtCalibration, input.frameWidthPx, input.frameHeightPx)) {
    log(`court: rejecting an implausible quad reported at ${courtCalibration.confidence.toFixed(3)} confidence`);
    knownLimitations.push(
      "The detected court was geometrically impossible for this frame and was discarded — "
      + "movement distances and in/out calls are unavailable. Mark the four corners in setup to fix this."
    );
    courtCalibration = { ...courtCalibration, confidence: 0, cornersImagePx: null };
  }

  if (courtCalibration.confidence === 0) {
    knownLimitations.push("Court calibration failed on every candidate frame tried — movement metrics will be null for every player.");
  }

  // Player detection, one Roboflow call per sampled frame. Sequential
  // (not Promise.all) on purpose — a free-tier hosted API can rate-limit
  // bursts, and this keeps VISION_FPS the actual throttle on call volume.
  const perFrameDetections: FrameDetectionSet[] = [];
  const localPlayers = playerDetectionIsLocal() && typeof (provider as {
    detectPlayersBatch?: unknown }).detectPlayersBatch === "function";

  stage("players", "finding the players");

  if (localPlayers) {
    // One local process for the whole clip. The hosted alternative spent a
    // Roboflow credit per sampled frame on a public COCO model -- ~500 per
    // 100-second clip at 5 fps -- which exhausted a free tier in a handful of
    // runs and then failed the analysis outright with a 402.
    log(`detecting players locally (${input.frames.length} frames, one pass)…`);
    let batch: Map<string, PlayerDetection[]>;
    try {
      batch = await (provider as unknown as {
        detectPlayersBatch: (f: typeof input.frames) => Promise<Map<string, PlayerDetection[]>>
      }).detectPlayersBatch(input.frames);
    } catch (err) {
      // Do NOT silently fall back to the hosted API here. Falling back is how
      // a local-only setup quietly starts spending credits again, which is the
      // exact failure this replaced. Say what is missing instead.
      throw new Error(
        `Local player detection failed: ${describeError(err)}. `
        + "Set PLAYER_DETECTION=roboflow to use the hosted API instead (it costs credits)."
      );
    }
    for (const frame of input.frames) {
      perFrameDetections.push({
        timestampSeconds: frame.timestampSeconds,
        framePath: frame.path,
        players: batch.get(frame.path) ?? [],
      });
    }
  } else {
    log(`detecting players via the hosted API (${input.frames.length} frames, one call each)…`);
    for (const [fi, frame] of input.frames.entries()) {
      if (fi > 0 && fi % 100 === 0) log(`  players: ${fi}/${input.frames.length} frames`);
      const players = await provider.detectPlayers(frame);
      perFrameDetections.push({ timestampSeconds: frame.timestampSeconds, framePath: frame.path, players });
    }
  }
  const totalDetections = perFrameDetections.reduce((n, f) => n + f.players.length, 0);
  log(`players: ${totalDetections} detections across ${perFrameDetections.length} frames`);
  if (totalDetections === 0) {
    knownLimitations.push("No people were detected in any sampled frame — nothing could be tracked.");
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
  // Gate in IMAGE space, not court space.
  //
  // The old test mapped a player's feet through the homography and checked a
  // generous court-coordinate range. That range has to be generous, because a
  // player legitimately stands behind the baseline -- but generous in court
  // units near the far baseline is enormous in pixels, since the whole far
  // half occupies a few dozen rows of a 720-line frame. The result was that
  // players on the courts either side, which sit near the same image rows as
  // the far court, passed the test. The polygon below widens along the court's
  // own edges, so the tolerance shrinks with distance exactly as the court does.
  const gatePolygon = playerGatePolygonPx(courtCalibration, input.frameHeightPx);
  const onCourt = (box: BoundingBoxNorm): boolean => {
    if (!gatePolygon) return true; // no usable court: keep everyone
    const feet: [number, number] = [
      (box.x + box.width / 2) * input.frameWidthPx,
      (box.y + box.height) * input.frameHeightPx,
    ];
    return pointInPolygon(feet, gatePolygon);
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
  else if (gatePolygon) log("court gate kept every detection — check the overlay if players from other courts appear");
  if (!gatePolygon) knownLimitations.push(
    "Without a usable court, players on neighbouring courts and spectators could not be excluded."
  );

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
  // Keep only the people the user pointed at during setup. Public courts come
  // with spectators, a queue behind the fence and two more games either side,
  // and every one of those tracked as a player corrupts the activity signal
  // the rally logic leans on.
  let selfPlayerId: string | null = null;
  let tracksToUse = tracks;
  if (input.setup && input.setup.players.length > 0) {
    const matched = matchTracksToSetup(tracks, input.setup);
    tracksToUse = matched.keep;
    selfPlayerId = matched.selfPlayerId;
    // Matching no longer drops anyone, so the only thing that can fail here is
    // working out which track is you -- and that only matters if you actually
    // marked yourself. Reporting "we could not match your players" whenever
    // selfPlayerId was null told users matching had failed when it had
    // succeeded and they simply had not tagged themselves.
    const markedSelf = input.setup.players.some((pl) => pl.isSelf);
    log(`setup: ${tracks.length} track(s)` + (selfPlayerId ? ` · you are ${selfPlayerId}` : ""));
    if (markedSelf && !selfPlayerId) {
      knownLimitations.push(
        "The player you marked as yourself could not be matched to any tracked player — " +
        "the tracker may have missed them on that frame, so the coaching read has no subject."
      );
    }
  }
  // Copy BEFORE clearing. `tracksToUse` starts out as `tracks` itself, so
  // emptying `tracks` in place empties the very array being read back -- and
  // every track vanishes. This only became reachable once matchTracksToSetup
  // stopped returning a filtered copy and started returning the caller's own
  // array, which is exactly the kind of aliasing that hides behind a
  // "keep everything" change looking harmless.
  const finalTracks = [...tracksToUse];
  tracks.length = 0;
  tracks.push(...finalTracks);

  log(`tracking: ${tracks.length} player track(s)`);
  if (tracks.length === 0) {
    knownLimitations.push("No player tracks survived (need >=2 sampled detections to count as a track).");
  } else if (tracks.length < 4) {
    knownLimitations.push(`Only ${tracks.length} stable player track(s) found; expected up to 4 for doubles.`);
  }

  // Pose per sampled frame, matched back to tracks by box overlap.
  let poses: PlayerPoseFrame[] = [];
  stage("pose", "estimating pose…");
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
  let netCrossings: NetCrossing[] = [];
  // Only rally_seg reports why a rally ended. Keyed by rally idx so the others
  // simply have no entry — absent, rather than a made-up reason.
  const rallyEndReasons = new Map<number, string>();
  let netLinePx: [[number, number], [number, number]] | null = null;
  let netBandPx: NetBand | null = null;
  let deadBallCount = 0;
  let contactRalliesWon = false;
  let ballGatePx: Array<[number, number]> | null = null;
  // Hoisted so the overlay, which is rendered at the very end from the values
  // the run actually used, can draw what the paddle model and the audio gate
  // produced instead of only reporting counts in the log.
  let paddlesSeen: PaddleObservation[] = [];
  let audioConfirmed: BallHit[] = [];
  // Hoisted so the overlay renderer at the end can draw the boundaries that
  // actually won, rather than whichever segmenter happened to run last.
  let ralliesUsed: ClusteredRally[] = [];
  let rallyOutput: AnalysisRallyOutput[] = [];
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
      stage("ball", `detecting the ball across the full ${input.videoDurationSeconds.toFixed(0)}s clip — first run downloads the model…`);
      // Tag detection failures so the catch below can tell them apart from a
      // failure in hit-scanning or shot classification. Blaming a full,
      // healthy ball track on "ball detection failed" sends every future
      // investigation to the wrong place -- which is exactly what happened.
      const raw = await detectBallViaPython(input.videoPath, [[0, input.videoDurationSeconds]])
        .catch((err) => { (err as { stage?: string }).stage = "detection"; throw err; });
      // Drop balls belonging to other courts BEFORE the track is built.
      // Filtering afterwards cannot help: the tracker has already chosen
      // between candidates frame by frame, and once it has followed a
      // neighbouring rally for a second the damage is a real-looking track of
      // somebody else's ball.
      const ballGate = ballGatePolygonPx(courtCalibration, input.frameHeightPx);
      ballGatePx = ballGate;
      let ballDetections = raw.detections;
      if (ballGate) {
        const before = ballDetections.length;
        ballDetections = ballDetections.filter((d) => pointInPolygon(
          [d.x * input.frameWidthPx, d.y * input.frameHeightPx], ballGate
        ));
        const dropped = before - ballDetections.length;
        log(`ball gate: kept ${ballDetections.length} of ${before} detections`
          + ` (${dropped} on other courts or off this one)`);
      } else {
        knownLimitations.push(
          "Without a usable court, balls on neighbouring courts could not be excluded from the ball track."
        );
      }
      const built = buildBallTrack(ballDetections, raw.fps, raw.framesProcessed);
      log(`ball: seen in ${Math.round(built.stats.coverage * 100)}% of ${built.stats.framesProcessed} frames (${JSON.stringify(raw.diagnostics.modelSource)})`);
      ballTrack = { points: built.points, stats: built.stats, diagnostics: raw.diagnostics, rawDetections: ballDetections };
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
        ballFps: raw.fps,
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
      // One physical speed floor, expressed correctly everywhere on the court.
      // Built once here because it needs the frame height to turn the track's
      // normalized rows back into the pixel rows the calibration is in.
      const foreshorteningAt = (yNorm: number): number | null =>
        courtForeshorteningAt(courtCalibration, yNorm * input.frameHeightPx);

      stage("contacts", "finding paddle contacts");
      const hitStats = newHitScanStats();
      let allHitsWide = detectHits(built.points, tracks, overheadAt, hitStats,
        STRICT_HIT_PARAMS, foreshorteningAt);
      // Zero hits is a common and previously silent outcome, and every cause
      // needs a different fix: too few observed points, every candidate too
      // slow, or a ball that never visibly turns. Say which.
      log(`hits: ${hitStats.hits} from ${hitStats.observed} observed of `
        + `${hitStats.points} track points · rejected `
        + `${hitStats.rejectedSlow} too slow, ${hitStats.rejectedStraight} too straight, `
        + `${hitStats.rejectedSpacing} too close together, ${hitStats.rejectedGapEdge} beside a gap`
        + ` · sharpest turn ${hitStats.bestTurnDeg.toFixed(0)}°`);

      // Audio proposes contacts the ball alone could not show.
      //
      // Placed BEFORE rally segmentation on purpose: rallies are clustered
      // from contacts, so a contact that arrives after the boundaries are
      // drawn cannot influence them -- and kitchen exchanges, the case this
      // exists for, are exactly where the boundaries come out wrong.
      //
      // Every onset is checked against the ball's own trajectory first (see
      // audio-contacts.ts). Onsets from the courts either side make a sound
      // but do not bend THIS ball, and are dropped.
      // Audio onsets first: candidate instants only, confirmed further down.
      let audioOnsets: Array<{ timestampSeconds: number; strength: number }> = [];
      let audioDiagnostics: Record<string, unknown> = {};
      if (audioContactsEnabled()) {
        try {
          const got = await detectAudioOnsetsViaPython(input.videoPath);
          audioOnsets = got.events;
          audioDiagnostics = got.diagnostics;
        } catch (err) {
          // A clip with no audio track is normal, not a failure of the analysis.
          log(`audio contacts unavailable: ${describeError(err).split("\n")[0]}`);
        }
      }

      // Paddle detection runs on its OWN terms.
      //
      // It used to sit inside the audio branch, which quietly made it
      // conditional on audio finding something: a clip with no usable audio got
      // no paddles at all, and -- because the overlay draws what the run
      // produced -- no way to see whether the paddle model works. Two separate
      // signals should not be able to take each other down.
      // PADDLE DETECTION BY MODEL IS GONE, deliberately.
      //
      // Four Roboflow models were measured on this footage. The best found a
      // paddle in 14% of sampled frames and cost ~50s a clip; the others were
      // nearer 1%. That is not four bad models -- a paddle is thin, edge-on
      // for much of a swing, motion-blurred exactly at contact, and from
      // behind the baseline the near player's is hidden by their own body
      // while the far player's is a few pixels. The camera cannot see it.
      //
      // Position now comes from the arm, which pose lands on the large
      // majority of frames. If a paddle model ever does work on baseline
      // footage, this is the place it goes back in -- alongside the estimate,
      // not instead of it, since the two fail in different places.
      let paddles: PaddleObservation[] = [];

      // The paddle, derived from the swinging arm. See paddle-from-pose.ts
      // for what this can and cannot claim: it is a position and a long-axis
      // direction, never a face angle.
      if (paddleFromPoseEnabled() && poses.length > 0) {
        const estimated = paddlesFromPoses(poses);
        if (estimated.length > 0) {
          paddles = estimated;
          paddlesSeen = estimated;
          log(`paddles: ${estimated.length} position(s) derived from the swinging arm`);
        } else {
          log("paddles: pose produced no readable swinging arm, so no paddle positions");
        }
      }

      if (audioContactsEnabled()) {
        if (audioOnsets.length === 0) {
          log(`audio: no paddle-like onsets found (${JSON.stringify(audioDiagnostics)})`);
        } else {
          const gateStats = newAudioGateStats();
          const confirmed = confirmAudioContacts({
            onsets: audioOnsets, ballPoints: built.points, tracks, paddles, stats: gateStats,
          });
          audioConfirmed = confirmed;
          const before = allHitsWide.length;
          allHitsWide = mergeHits(allHitsWide, confirmed, AUDIO_GATE_PARAMS.minSpacingS);
          log(`audio: ${gateStats.onsets} onsets → ${gateStats.accepted} confirmed by the ball `
            + `(rejected ${gateStats.rejectedNoBall} with no ball either side, `
            + `${gateStats.rejectedGappy} where the ball was too sparse to fit a velocity, `
            + `${gateStats.rejectedNotTowardPlayer} not travelling at a player, `
            + `${gateStats.rejectedNoChange} where the ball never changed — other courts, `
            + `${gateStats.rejectedSpacing} duplicates) · contacts ${before} → ${allHitsWide.length}`);
          if (gateStats.accepted === 0) {
            knownLimitations.push(
              `Audio found ${gateStats.onsets} paddle-like sounds but none coincided with a change in this ball's ` +
              `flight, so none were counted — on a court with games either side that is the expected result when ` +
              `the ball itself was not tracked well.`
            );
          }
        }
      }

      // Two ways to draw the boundaries. Hit clustering groups contacts by the
      // gaps between them; rally_seg reads the ball's physics and ends a rally
      // on evidence the point is actually over (a bounce outside the lines, a
      // ball dying in the net, a double bounce). rally_seg is opt-in via
      // RALLY_SEGMENTER and falls back here on any failure, so an analysis run
      // can never be taken down by it.
      let rallies = clusterRalliesFromHits(allHitsWide.map((h) => h.t), input.videoDurationSeconds, HIT_CLUSTER_PARAMS);
      let rallySource = `${allHitsWide.length} ball hits`;

      // Contacts first: a rally is the ball being hit by both sides.
      //
      // A contact is attributed to whichever tracked player was nearest, and
      // the players are tracked on the ground plane where the court geometry
      // is exact. That is the advantage over crossings: deciding which side of
      // the net a ball in FLIGHT is on is undecidable inside the net band from
      // this camera -- the tape is ~73px tall in the image while the entire
      // far court is ~44px -- whereas a player standing on the court is not
      // ambiguous at all.
      const sideOfHit = (h: BallHit): "near" | "far" | null => {
        if (!h.playerId) return null;
        const tr = tracks.find((t) => t.playerId === h.playerId);
        if (!tr) return null;
        let best: PlayerTrack["points"][number] | null = null;
        let bestDt = 0.4;
        for (const p of tr.points) {
          const dt = Math.abs(p.timestampSeconds - h.t);
          if (dt < bestDt) { bestDt = dt; best = p; }
        }
        return best ? sideOf(best.boxImageNorm) : null;
      };

      if (contactRalliesEnabled()) {
        // Two passes, because contacts and rally windows define each other.
        //
        // The strict scan has to survive a whole clip of dead time, so it is
        // sceptical and misses real contacts on a sparse track. The permissive
        // scan is only safe INSIDE a rally, where the ball is in play by
        // definition -- but knowing where the rallies are is what we are
        // trying to work out. So: cluster once on the strict contacts to get
        // provisional windows, rescan inside those, then cluster again on the
        // fuller set. The second clustering is the one that counts.
        const provisional = clusterRalliesFromContacts(
          allHitsWide, sideOfHit, input.videoDurationSeconds
        ).rallies;
        if (provisional.length > 0) {
          const before = allHitsWide.length;
          const inRallyStats = newHitScanStats();
          let found: BallHit[] = [];
          for (const r of provisional) {
            const seg = sliceTrack(built.points, r.startS, r.endS);
            if (seg.length < 5) continue;
            found = found.concat(
              detectHits(seg, tracks, overheadAt, inRallyStats, IN_RALLY_HIT_PARAMS, foreshorteningAt)
            );
          }
          allHitsWide = mergeHits(allHitsWide, found, IN_RALLY_HIT_PARAMS.minSpacingS);
          log(`  contacts: ${before} strict → ${allHitsWide.length} after rescanning `
            + `${provisional.length} provisional rall${provisional.length === 1 ? "y" : "ies"}`);
        }

        const { rallies: contactRallies, dead } = clusterRalliesFromContacts(
          allHitsWide, sideOfHit, input.videoDurationSeconds
        );
        log(`contacts → rallies: ${allHitsWide.length} contacts → ${contactRallies.length} rall`
          + `${contactRallies.length === 1 ? "y" : "ies"}`
          + (contactRallies.length
            ? ` (${contactRallies.map((r) => `${r.startS.toFixed(0)}-${r.endS.toFixed(0)}s ${r.nearContacts}n/${r.farContacts}f`).join(", ")})`
            : ""));
        if (dead.length > 0) {
          // Not rallies, but each was a point: a serve into the net, a ball
          // nobody returned. Worth naming rather than silently dropping.
          const oneSide = dead.filter((d) => d.reason === "one-side-only");
          if (oneSide.length) {
            log(`  ${oneSide.length} group(s) hit by one side only — no return `
              + `(${oneSide.map((d) => `${d.startS.toFixed(0)}s`).join(", ")})`);
          }
          deadBallCount = dead.length;
        }
        if (contactRallies.length > 0) {
          rallies = contactRallies;
          contactRalliesWon = true;
          rallySource = `${allHitsWide.length} paddle contacts, both sides`;
        }
      }

      // Net crossings as the fallback: a rally is the ball going over and coming back,
      // which is the rule rather than a statistic about it. The two segmenters
      // below infer boundaries from contact timing or ball physics; this one
      // reads the definition directly, and is the only one that will not call
      // a player bouncing the ball on the floor a rally.
      if (!contactRalliesWon && netRalliesEnabled()) {
        const { crossings, net, band } = detectNetCrossings(
          built.points, courtCalibration, input.frameWidthPx, input.frameHeightPx
        );
        netCrossings = crossings;
        netLinePx = net;
        netBandPx = band;
        if (!net) {
          log("net crossings: no usable court, so the net line is unknown — falling back");
          knownLimitations.push(
            "Rally boundaries could not be read from net crossings because the court was not calibrated. "
            + "Mark the four corners in setup for the most reliable boundaries."
          );
        } else {
          const { rallies: netRallies, deadBalls } = segmentNetCrossings(crossings, input.videoDurationSeconds);
          if (deadBalls.length > 0) {
            // Not rallies, but not nothing: a ball that crossed once and never
            // came back is a point conceded. Recorded as events so the coaching
            // layer can say "three serves into the net" -- a fact no rally
            // count contains.
            log(`  ${deadBalls.length} one-way crossing(s) — ball over and never returned `
              + `(${deadBalls.map((d) => `${d.t.toFixed(0)}s`).join(", ")})`);
            // Deliberately NOT pushed as unknown_shot events. facts.ts
            // re-derives rallies by clustering those, so a dead ball added
            // there would manufacture a rally out of the very thing that is
            // not one. They travel as their own count instead.
            deadBallCount = deadBalls.length;
          }
          log(`net crossings: ${crossings.length} confirmed → ${netRallies.length} rall${netRallies.length === 1 ? "y" : "ies"}`
            + (netRallies.length ? ` (${netRallies.map((r) => `${r.startS.toFixed(0)}-${r.endS.toFixed(0)}s×${r.crossings}`).join(", ")})` : ""));
          if (netRallies.length > 0) {
            rallies = netRallies;
            rallySource = `${crossings.length} net crossings`;

            // Same two-pass rescan as the contact segmenter, since this path
            // only runs when that one found nothing at all.
            const before = allHitsWide.length;
            let found: BallHit[] = [];
            for (const r of netRallies) {
              const seg = sliceTrack(built.points, r.startS, r.endS);
              if (seg.length < 5) continue;
              found = found.concat(
                detectHits(seg, tracks, overheadAt, newHitScanStats(), IN_RALLY_HIT_PARAMS, foreshorteningAt)
              );
            }
            allHitsWide = mergeHits(allHitsWide, found, IN_RALLY_HIT_PARAMS.minSpacingS);
            const inferred = inferHitsBetweenCrossings(
              built.points, crossings.map((c) => c.t), allHitsWide, IN_RALLY_HIT_PARAMS.minSpacingS
            );
            allHitsWide = mergeHits(allHitsWide, inferred, IN_RALLY_HIT_PARAMS.minSpacingS);
            log(`  contacts: ${before} strict → ${allHitsWide.length}`);
          } else if (crossings.length > 0) {
            // Crossings but no rally means every run was a single crossing --
            // a serve into the net, a feed, a ball knocked to the next court.
            log("  every crossing was one-way; nothing went over and came back");
          }
        }
      }

      if (rallies.length === 0 && rallySegEnabled()) {
        log("rally boundaries: trying rally_seg…");
        const seg = await segmentRalliesViaRallySeg({
          videoPath: input.videoPath,
          durationSeconds: input.videoDurationSeconds,
          frameWidthPx: input.frameWidthPx,
          frameHeightPx: input.frameHeightPx,
          detections: raw.detections,
          fps: raw.sourceFps || raw.fps,
          framesProcessed: raw.framesProcessed,
          calibration: courtCalibration,
          debugId: input.debugId,
          courtOverride: setupCourtForRallySeg(input.setup ?? null),
          configOverrides: rallySegOverridesForSetup(input.setup ?? null),
          onLog: (line) => log(`  rally_seg: ${line}`),
        });
        if (seg && seg.rallies.length > 0) {
          rallies = seg.rallies;
          rallySource = "rally_seg (ball trajectory)";
          for (const w of seg.warnings) knownLimitations.push(`rally_seg: ${w}`);
          const lowConfidence = seg.detail.filter((d) => d.confidence < 0.5);
          if (lowConfidence.length > 0) {
            knownLimitations.push(
              `${lowConfidence.length} of ${seg.detail.length} rally boundaries are low-confidence ` +
              `(${lowConfidence.map((d) => `#${d.idx + 1}`).join(", ")}) — worth checking before trusting those clips.`
            );
          }
          for (const d of seg.detail) rallyEndReasons.set(d.idx, d.endReason);
          log(`  rally_seg endings: ${seg.detail.map((d) => d.endReason).join(", ")}`);
          if (seg.debugVideoUrl) log(`  annotated video: http://localhost:3000${seg.debugVideoUrl}`);
        } else {
          log("  rally_seg produced nothing usable — using hit clustering");
        }
      }

      // Keep-alive: crossings decided where each rally BEGAN; alternating
      // contacts decide how long it lasted. Runs after every segmenter has
      // resolved, so it extends whichever one won rather than competing with
      // them, and it can only ever lengthen a rally — never create, shorten or
      // merge one.
      // Captured BEFORE keep-alive so each rally can report how much it was
      // extended, rather than only a clip-wide total.
      const endsBeforeKeepAlive = new Map(rallies.map((r) => [r.idx, r.endS]));

      if (keepAliveEnabled() && rallies.length > 0) {
        const kaContacts = allHitsWide.map((h) => ({ t: h.t, side: sideOfHit(h) }));
        const ka = extendRalliesWhileLive(rallies, kaContacts, input.videoDurationSeconds);
        if (ka.extended > 0) {
          const longest = Math.max(...ka.rallies.map((r, i) => r.endS - rallies[i].endS));
          log(`keep-alive: ${ka.extended} of ${rallies.length} rallies held open through `
            + `continued back-and-forth (+${ka.addedSeconds}s total, longest +${longest.toFixed(1)}s)`);
          rallies = ka.rallies;
        } else {
          log("keep-alive: no rally had alternating contacts after its last net crossing");
        }
      }

      // Ky's rule: contacts from both sides with the ball changing trajectory
      // across the net means a rally is going on; the ball bouncing up and
      // down on ONE side means the rally is over and somebody is just bouncing
      // it. Every segmenter above answers the first half from where the
      // STRIKER stood, which a player bouncing a ball at the net can fool --
      // the nearest player to alternate contacts can be their opponent
      // standing a few feet away. This asks the ball instead, and only ever
      // shortens or removes a rally. See ball-exchange.ts for why the bounce
      // verdict cannot fire on a kitchen dink.
      const netForBounce = netLinePx
        ?? netLineImagePx(courtCalibration, input.frameWidthPx, input.frameHeightPx);
      if (bounceRuleEnabled() && rallies.length > 0 && netForBounce) {
        const netDistance = (pt: { x: number; y: number }) =>
          sideOfNet(pt, netForBounce, input.frameWidthPx, input.frameHeightPx);
        const classify = (a: number, b: number) =>
          classifyBetween(built.points, a, b, netDistance);
        // Contacts come from the hit list rather than rally.contacts, because
        // the net-crossing segmenter does not populate that field and the rule
        // has to work whichever segmenter won.
        const shadow = rallies.map((r) => ({
          idx: r.idx,
          startS: r.startS,
          endS: r.endS,
          contacts: allHitsWide.filter((h) => h.t >= r.startS && h.t <= r.endS).map((h) => h.t),
        }));
        // The double bounce first, because it is the RULE and not an
        // inference: a ball that lands twice on one side with nobody hitting
        // it in between has ended the point, whatever anything else suggests.
        const contactTimes = allHitsWide.map((h) => h.t);
        const { rallies: afterDouble, stats: dbStats } = applyDoubleBounceRule(
          shadow,
          (a, b) => detectBounces(sliceTrack(built.points, a, b), contactTimes),
          contactTimes,
          netDistance,
          HIT_CLUSTER_PARAMS.tailS
        );
        if (dbStats.ended > 0) {
          log(`double-bounce rule: ${dbStats.ended} rall${dbStats.ended === 1 ? "y" : "ies"} ended `
            + `where the ball bounced twice on one side (-${dbStats.trimmedSeconds}s)`);
        }

        const { rallies: kept, stats: bounceStats } = applyBounceRule(
          afterDouble, classify, HIT_CLUSTER_PARAMS.tailS
        );
        if (dbStats.ended > 0 || bounceStats.dropped > 0 || bounceStats.trimmed > 0) {
          const endById = new Map(kept.map((r) => [r.idx, r.endS]));
          // Which rallies these rules actually changed, so each can say why it
          // ended rather than the clip carrying one anonymous total.
          const endedByDoubleBounce = new Set(
            afterDouble.filter((r) => r.endS < (shadow.find((sh) => sh.idx === r.idx)?.endS ?? Infinity) - 1e-6)
              .map((r) => r.idx)
          );
          const trimmedByBouncing = new Set(
            kept.filter((r) => {
              const prior = afterDouble.find((a) => a.idx === r.idx)?.endS ?? Infinity;
              return r.endS < prior - 1e-6;
            }).map((r) => r.idx)
          );
          const priorReasons = new Map(rallies.map((r) => [r.idx, rallyEndReasons.get(r.idx)]));
          const survivors = rallies.filter((r) => endById.has(r.idx));
          // Re-key the end reasons onto the new numbering FIRST: renumbering
          // without this would quietly attach each rally's reason to a
          // different rally.
          rallyEndReasons.clear();
          survivors.forEach((r, i) => {
            const reason = endedByDoubleBounce.has(r.idx)
              ? "the ball bounced twice on one side"
              : trimmedByBouncing.has(r.idx)
                ? "the ball stopped crossing the net"
                : priorReasons.get(r.idx);
            if (reason) rallyEndReasons.set(i + 1, reason);
          });
          // Renumbered so idx stays 1..n: analysis_shots.rally_idx joins on
          // it, and a gap would point shots at a rally that is not there.
          rallies = survivors.map((r, i) => ({ ...r, idx: i + 1, endS: endById.get(r.idx)! }));
          if (bounceStats.dropped > 0 || bounceStats.trimmed > 0) {
            log(`ball-bounce rule: ${bounceStats.dropped} group(s) dropped as one-side bouncing, `
              + `${bounceStats.trimmed} rall${bounceStats.trimmed === 1 ? "y" : "ies"} cut back to the `
              + `last exchange (-${bounceStats.trimmedSeconds}s)`);
          }
          if (bounceStats.dropped > 0) {
            knownLimitations.push(
              `${bounceStats.dropped} contact group(s) were not counted as rallies: the ball stayed on `
              + `one side of the net and bounced rather than being exchanged.`
            );
          }
        } else {
          log("ball-bounce rules: no double bounce and no one-side bouncing found");
        }
      } else if (bounceRuleEnabled() && rallies.length > 0) {
        log("ball-bounce rule: skipped — the net line is unknown without a calibrated court");
      }

      stage("rallies", `segmenting rallies from ${rallySource}`);
      ralliesUsed = rallies;

      // Everything the frontend needs to describe a rally WITHOUT the coaching
      // pass having run: where it is, which segmenter drew it, why it ended,
      // and who hit what inside it.
      const rallySourceKind: AnalysisRallyOutput["source"] =
        rallySource.includes("net crossing") ? "net-crossings"
        : rallySource.includes("rally_seg") ? "rally_seg"
        : rallySource.includes("paddle contacts") ? "contacts"
        : rallySource.includes("ball hits") ? "hit-clustering"
        : "unknown";

      rallyOutput = rallies.map((r) => {
        const before = endsBeforeKeepAlive.get(r.idx);
        const inWindow = allHitsWide.filter((h) => h.t >= r.startS && h.t <= r.endS);
        return {
          idx: r.idx,
          startS: Math.round(r.startS * 1000) / 1000,
          endS: Math.round(r.endS * 1000) / 1000,
          source: rallySourceKind,
          // Only rally_seg reports a reason today; the others genuinely do not
          // know one, and null says so rather than inventing "ended".
          endReason: rallyEndReasons.get(r.idx) ?? null,
          contactCount: inWindow.length,
          crossingCount: netCrossings.length
            ? netCrossings.filter((c) => c.t >= r.startS && c.t <= r.endS).length
            : null,
          extendedSeconds: before === undefined
            ? 0
            : Math.round(Math.max(0, r.endS - before) * 100) / 100,
          contacts: inWindow.map((h) => {
            const side = sideOfHit(h);
            return {
              t_s: Math.round(h.t * 1000) / 1000,
              // "near"/"far" is a court side; "self"/"opponent" is what the UI
              // needs, and only the tagged self track can decide it.
              side: (side === null || !selfPlayerId
                ? "unknown"
                : h.playerId === selfPlayerId ? "self" : "opponent") as "self" | "opponent" | "unknown",
              confidence: Math.round(h.confidence * 100) / 100,
            };
          }),
        };
      });

      if (rallies.length === 0) {
        knownLimitations.push("No ball hits were detected sharply enough to identify any rallies — shot types were not classified.");
      }
      log(`segmented ${rallies.length} rallies from ${rallySource}`);

      // A swing lasts about a third of a second. At VISION_FPS (5) that is one
      // or two frames, so the pose data physically cannot contain a swing --
      // which is why the technique read was two numbers averaged over a whole
      // rally. Sampling the whole clip fast enough would be ~6x the pose work
      // on footage that is mostly players standing still; sampling in bursts
      // around the contacts puts the frames where the information is.
      //
      // These land in the same `poses` array as the 5 fps pass, so they are
      // persisted, drawn on the overlay, and read by the coaching layer with
      // no separate plumbing.
      if (input.tempDir && allHitsWide.length > 0) {
        try {
          const { extractFrameWindows } = await import("@/lib/video/ffmpeg");
          const { estimatePosesForFrames } = await import("./pose");
          const burstFps = Math.min(30, Math.max(12, raw.sourceFps || raw.fps || 24));
          const windows = allHitsWide.map((h) => ({
            startSeconds: Math.max(0, h.t - SWING_WINDOW_S),
            endSeconds: Math.min(input.videoDurationSeconds, h.t + SWING_WINDOW_S),
          }));
          const burstFrames = await extractFrameWindows(input.videoPath, input.tempDir, windows, {
            fps: burstFps,
            maxDimension: Math.max(input.frameWidthPx, 1280),
          });
          if (burstFrames.length > 0) {
            // Burst frames sit BETWEEN the 5 fps track samples, so pose-to-track
            // matching needs a tolerance or every one of them is dropped.
            const burstPoses = await estimatePosesForFrames(burstFrames, tracks, 1 / input.visionFps);
            // Deduplicate before merging. A burst window starts at a contact
            // time and steps at the burst rate, so some of its frames land on
            // exactly the 5 fps grid the first pass already covered. Those
            // duplicates would be written to player_keypoints twice and then
            // counted twice by every average built from them.
            const seen = new Set(poses.map((p) => `${p.playerId}@${p.timestampSeconds.toFixed(3)}`));
            const fresh = burstPoses.filter((p) => {
              const key = `${p.playerId}@${p.timestampSeconds.toFixed(3)}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            poses = [...poses, ...fresh].sort((a, b) => a.timestampSeconds - b.timestampSeconds);
            log(`swing detail: ${burstFrames.length} extra frames at ${burstFps.toFixed(0)} fps around `
              + `${allHitsWide.length} contacts → ${fresh.length} more pose readings `
              + `(${burstPoses.length - fresh.length} were duplicates of the 5 fps pass) `
              + `· ${poses.length} poses total`);
          } else {
            log("swing detail: no burst frames were produced — technique stays at rally-level averages");
          }
        } catch (err) {
          // Never let the technique extra take down an analysis that otherwise worked.
          knownLimitations.push(
            `Close-up pose around contacts failed, so shot-by-shot technique was not measured: ${describeError(err).split("\n")[0]}`
          );
          log(`swing detail failed: ${describeError(err).split("\n")[0]}`);
        }
      } else if (!input.tempDir) {
        knownLimitations.push(
          "Shot-by-shot technique was not measured: no scratch directory was available for close-up pose sampling."
        );
      }

      stage("shots", "classifying shots");
      const allHits: BallHit[] = [];
      for (const r of rallies) {
        const pts = sliceTrack(built.points, r.startS - 0.3, r.endS + 0.3);

        // Use the contacts already found, not a fresh strict scan.
        //
        // This used to re-run detectHits per rally, which threw away every
        // contact the in-rally rescan and the crossing inference had added --
        // the whole point of finding them. Measured: 35 contacts became 11
        // shots, because the classifier never saw 24 of them.
        //
        // The original reason for re-detecting was edge-of-array context, and
        // that reason is gone: the windows are time-bounded now (neighbourAt),
        // so a hit near a slice boundary is judged by its neighbours in time
        // rather than by its index. Falling back to a local scan only when the
        // global one found nothing in this window keeps the old behaviour
        // available where it still helps.
        let hits = allHitsWide.filter((h) => h.t >= r.startS - 0.3 && h.t <= r.endS + 0.3);
        if (hits.length === 0) hits = detectHits(pts, tracks, overheadAt, undefined, STRICT_HIT_PARAMS, foreshorteningAt);

        const bounces = detectBounces(pts, hits.map((h) => h.t));
        allHits.push(...hits);
        shots.push(...classifyRally({ rallyIdx: r.idx, startS: r.startS, endS: r.endS, hits, bounces, ballPoints: pts }, ctx));
      }

      // Mechanics belong to the SHOT, and are measured here rather than in the
      // coaching layer for two reasons: the pose bursts and the shots both
      // exist at this point, and doing it here means a clip has mechanics even
      // when no coaching read was ever generated. facts.ts computed them for
      // the tagged self player only; measuring per shot covers whoever actually
      // hit it, so an opponent's swing is available too.
      //
      // A shot with no attributed player, or one the burst never covered,
      // keeps `mechanics` UNDEFINED. It is never an object of nulls: a coach —
      // human or model — handed a knee angle of null still writes about knees.
      stage("mechanics", "measuring your swing at each contact");
      let measured = 0;
      for (const shot of shots) {
        if (!shot.playerId) continue;
        const forPlayer = poses.filter((pp) => pp.playerId === shot.playerId);
        if (forPlayer.length === 0) continue;
        const m = measureSwing(forPlayer, shot.t);
        if (m.samples < 4 || m.confidence < 0.3) continue;
        const anyField = m.kneeAngleAtContactDeg !== null || m.contactHeightTorsos !== null
          || m.backswingShoulders !== null || m.wristSpeedIntoContact !== null;
        if (!anyField) continue;
        shot.mechanics = m;
        measured += 1;
      }
      log(`mechanics: measured on ${measured} of ${shots.length} shots`
        + `${shots.length ? ` (${Math.round((measured / shots.length) * 100)}%)` : ""}`);

      log(`  ${allHits.length} contact(s) inside rallies went to shot classification`);
      events.push(...hitsToUnknownShotEvents(allHits));
    } catch (err) {
      if (err instanceof BallModelNotConfiguredError) {
        knownLimitations.push(err.message);
      } else {
        const stage = (err as { stage?: string }).stage === "detection" ? "Ball detection" : "Shot analysis";
        const detail = describeError(err).split("\n")[0];
        knownLimitations.push(`${stage} failed, so shot types were not classified: ${detail}`);
        log(`${stage.toLowerCase()} failed: ${detail}`);
      }
      shots = [];
    }
  }

  // The overlay is rendered here, at the end, from the values the run actually
  // used -- after every fallback has been resolved, so it can never show a
  // court or a set of boundaries that lost.
  let debugVideoUrl: string | null = null;
  if (debugRenderEnabled() && input.debugId) {
    stage("overlay", "rendering the annotated overlay (a full decode and re-encode)…");
    debugVideoUrl = await renderDebugVideo({
      videoPath: input.videoPath,
      analysisId: input.debugId,
      durationSeconds: input.videoDurationSeconds,
      frameWidthPx: input.frameWidthPx,
      frameHeightPx: input.frameHeightPx,
      calibration: courtCalibration,
      netLinePx,
      netBandPx,
      ballGatePx,
      ballPoints: ballTrack.points,
      crossings: netCrossings,
      rallies: ralliesUsed,
      tracks,
      poses,
      paddles: paddlesSeen,
      audioContacts: audioConfirmed.map((h) => ({ t: h.t, x: h.ball.x, y: h.ball.y, playerId: h.playerId })),
      selfPlayerId,
      onLog: (l) => log(`  ${l}`),
    });
    log(debugVideoUrl
      ? `  annotated video: http://localhost:3000${debugVideoUrl}`
      : "  no annotated video was produced");
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
    deadBallCount,
    ballCoverage: ballTrack.stats?.coverage ?? null,
    shotsClassified: shots.filter((s) => s.type !== "unknown").length,
    knownLimitations,
  };

  return {
    providerName: provider.name,
    selfPlayerId,
    courtCalibration,
    perFrameDetections,
    tracks,
    poses,
    movement,
    footwork,
    events,
    ballTrack,
    shots,
    rallies: rallyOutput,
    debugVideoUrl,
    quality,
  };
}
