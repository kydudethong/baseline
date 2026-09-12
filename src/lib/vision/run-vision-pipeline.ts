import { getPhase2VisionProvider, playerDetectionIsLocal } from "./provider-v2";
import { analyzeMovementWithCalibration } from "./provider-v2";
import { hitsToUnknownShotEvents, detectFootworkFoundation } from "./events";
import { computeAppearanceSignaturesViaPython, detectBallViaPython, BallModelNotConfiguredError, ballModelConfigured } from "./cv-scripts";
import { buildBallTrack, detectBounces, detectHits, STRICT_HIT_PARAMS, newHitScanStats, type BallDetection, type BallHit, type BallTrackPoint, type BallTrackStats } from "./ball";
import { classifyRally, courtFrameFor, sideOf as courtSideOf, type Shot } from "./shots";
import type { AnalysisStage } from "@/lib/db/types";
import { StageTimer } from "@/lib/analysis/stage-timer";
import { SWING_WINDOW_S, measureSwing } from "./swing";
import { ballGatePolygonPx, calibrationFromSetup, courtForeshorteningAt, isPlausibleCourtQuad, playerGatePolygonPx, pointInPolygon, transformToCourtCoordinates } from "./court";
import type { ClusteredRally } from "./rallies";
import { netBandImagePx, netLineImagePx, type NetBand, type NetCrossing } from "./rallies-net";
import { debugRenderEnabled, renderDebugVideo } from "./debug-render";
import { smoothPoseFrames } from "./pose-smooth";
import { gateImplausibleLimbs } from "./pose-limbs";
import { majoritySide, partnerGap, partnerOf, zoneBreakdown, type PlayerPositions } from "./positioning";
import { makeCvProxy } from "@/lib/video/ffmpeg";
import path from "node:path";
import { describeError } from "@/lib/analysis/describe-error";
import { detectCourtViaRallySeg, rallySegCourtEnabled } from "./court-rally-seg";
import {
  matchTracksToSetup, rallySegOverridesForSetup,
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
  /**
   * Which track is the subject, named outright.
   *
   * The app works this out by matching what the user clicked during setup to
   * a track. The offline harness has no setup screen, so every run it ever
   * did had selfPlayerId null -- which drew no YOU box on the overlay and
   * left any coaching read without a subject. That was invisible until a
   * VLM watching the overlay pointed out there was no gold box in it.
   *
   * Ignored when `setup` carries a marked player: a person who pointed at
   * themselves on a real frame outranks an id typed on a command line.
   */
  selfPlayerId?: string | null;
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
  /**
   * Where the time goes. Passed IN rather than created here so the caller's
   * earlier stages -- downloading the video, extracting frames -- land in the
   * same breakdown. A timer that starts when the CV work starts cannot tell
   * you that a third of the run went on the download.
   */
  timer?: StageTimer;
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
  // Stages are already announced one at a time; timing them is just measuring
  // the gaps between those announcements. A caller that passed no timer gets
  // a local one, so the breakdown is logged either way -- it just starts at
  // the CV work rather than at the download.
  const timer = input.timer ?? new StageTimer();
  const stage = (name: AnalysisStage, message: string) => {
    timer.mark(name);
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
  if (input.selfPlayerId) {
    // Named directly. Checked against the tracks that exist rather than
    // trusted, because a typo would otherwise fail exactly the way the bug
    // this fixes did: silently, with no subject and no complaint.
    const known = tracks.some((t) => t.playerId === input.selfPlayerId);
    if (known) {
      selfPlayerId = input.selfPlayerId;
      log(`setup: you are ${selfPlayerId} (named directly)`);
    } else {
      log(`setup: no track called ${input.selfPlayerId} — tracks are `
        + `${tracks.map((t) => t.playerId).join(", ") || "(none)"}`);
      knownLimitations.push(
        `No tracked player is called ${input.selfPlayerId}, so this run has no subject.`
      );
    }
  }
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
  // Always empty now: crossings were rally evidence and nothing computes them.
  // Kept as a field so the overlay renderer's shape does not have to change.
  const netCrossings: NetCrossing[] = [];
  let netLinePx: [[number, number], [number, number]] | null = null;
  let netBandPx: NetBand | null = null;
  // Always 0: dead balls were counted by the segmenters that are gone.
  const deadBallCount = 0;
  let ballGatePx: Array<[number, number]> | null = null;
  // Hoisted so the overlay, which is rendered at the very end from the values
  // the run actually used, can draw what the paddle model and the audio gate
  // produced instead of only reporting counts in the log.
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
      // Read a downscaled copy rather than the original where that is
      // cheaper. Returns null -- and costs nothing -- when the source is
      // already at or below the target, which is the common case for phone
      // footage at 720p. See makeCvProxy for why this is conditional.
      // No temp dir means nowhere to put the proxy, so read the original --
      // the same path taken when the source is already small enough.
      const ballProxy = input.tempDir
        ? await makeCvProxy(
            input.videoPath,
            path.join(input.tempDir, "cv-proxy.mp4"),
            { sourceWidth: input.frameWidthPx }
          )
        : null;
      if (ballProxy) {
        log(`ball: reading a ${1280}px-wide proxy instead of the ${input.frameWidthPx}px original`);
      }
      // Tag detection failures so the catch below can tell them apart from a
      // failure in hit-scanning or shot classification. Blaming a full,
      // healthy ball track on "ball detection failed" sends every future
      // investigation to the wrong place -- which is exactly what happened.
      const raw = await detectBallViaPython(ballProxy ?? input.videoPath, [[0, input.videoDurationSeconds]])
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

      stage("contacts", "finding ball contacts");
      const hitStats = newHitScanStats();
      const allHitsWide = detectHits(built.points, tracks, overheadAt, hitStats,
        STRICT_HIT_PARAMS, foreshorteningAt);
      // Zero hits is a common and previously silent outcome, and every cause
      // needs a different fix: too few observed points, every candidate too
      // slow, or a ball that never visibly turns. Say which.
      log(`hits: ${hitStats.hits} from ${hitStats.observed} observed of `
        + `${hitStats.points} track points · rejected `
        + `${hitStats.rejectedSlow} too slow, ${hitStats.rejectedStraight} too straight, `
        + `${hitStats.rejectedSpacing} too close together, ${hitStats.rejectedGapEdge} beside a gap`
        + ` · sharpest turn ${hitStats.bestTurnDeg.toFixed(0)}°`);

      // AUDIO CONTACTS AND THE POSE-DERIVED PADDLE ARE BOTH GONE.
      //
      // Audio: measured on this clip it turned 51 contacts into 63 -- 100
      // onsets of which 16 survived the ball-agreement gate. A 24% lift, for
      // a whole Python pass, a second signal to reason about, and a gate with
      // five distinct rejection reasons. It bought contacts that shot
      // classification no longer needs, because shot types are Gemini's job
      // now and it reads them off the video rather than off a contact list.
      //
      // Paddle from pose: it fed exactly one +0.1 confidence term and drew a
      // shape on the overlay. Four detection models were measured before it
      // and none worked; the arm-derived estimate was the honest fallback,
      // and with technique judgment moving to a model that watches the
      // footage, an estimated paddle position is a thing to be wrong about
      // rather than a thing to reason from.
      //
      // Both are in git if the trade turns out badly.

      // RALLY BOUNDARIES ARE GEMINI'S. Everything that used to live here --
      // hit clustering, contact clustering, net-crossing segmentation,
      // rally_seg, keep-alive extension and the two bounce rules -- has been
      // removed, and this is the whole of what replaced it.
      //
      // WHY, given net crossings measured 6/6 on ky-720p. Because it was never
      // only a segmenter: run-coaching.ts refused to call Gemini at all when
      // the local pass found zero rallies, so a bad court fit or a sparse ball
      // track silently produced "not enough movement data" instead of asking
      // the component that is better at this. Gemini found 7/7 auditing the
      // overlay and caught two real segmenter bugs that Ky then confirmed by
      // watching the footage: a rally ended at 29s when play ran to 33.5s, and
      // keep-alive holding rally 6 open 3.2s past a finished point. A fallback
      // that gates the thing it is a fallback FOR is not a safety net.
      //
      // The net LINE AND BAND are both still computed, because both are pure
      // court geometry rather than rally evidence, and the overlay legend --
      // which IS the prompt -- tells Gemini what the band means: a ball inside
      // it cannot be assigned to a side, because from behind a baseline the
      // net stands between the camera and the far court. That ambiguity is
      // real and Gemini should see it marked.
      //
      // CROSSINGS are not computed. Those are rally evidence, and drawing them
      // would hand Gemini the answer to the question it is being asked, which
      // is the mistake --hide-rallies exists to prevent.
      netBandPx = netBandImagePx(courtCalibration, input.frameWidthPx, input.frameHeightPx);
      netLinePx = netBandPx?.base
        ?? netLineImagePx(courtCalibration, input.frameWidthPx, input.frameHeightPx);

      stage("rallies", "leaving rally boundaries to the coaching pass");
      ralliesUsed = [];
      rallyOutput = [];
      log("rallies: not segmented here — Gemini draws them from the overlay");

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

      // MEASUREMENT IS OURS; INTERPRETATION IS GEMINI'S.
      //
      // One pass over the whole clip rather than one per rally, because there
      // are no rallies here any more. classifyRally still earns its place: it
      // computes where the hitter stood, where the ball landed, the zones,
      // approximate speed, arc, and whether the ball bounced first. All of
      // that is measurement.
      //
      // What it ALSO produces is a shot type, and that is not ours under Ky's
      // split -- so type, category and outcome are cleared below rather than
      // shipped as though this system still decided them. analyst-facts.ts
      // already withholds shot types from the prompt, so Gemini was never
      // biased by them; but analysis_shots feeds the UI directly, and a
      // "third_shot_drop" sitting there would be this system asserting
      // something it no longer works out.
      stage("shots", "measuring each contact");
      const allHits: BallHit[] = allHitsWide;
      if (allHits.length > 0) {
        const pts = built.points;
        const bounces = detectBounces(pts, allHits.map((h) => h.t));
        shots.push(...classifyRally(
          { rallyIdx: 0, startS: 0, endS: input.videoDurationSeconds, hits: allHits, bounces, ballPoints: pts },
          ctx
        ));
        for (const sh of shots) {
          sh.type = "unknown";
          sh.category = "unknown";
          sh.outcome = "unknown";
        }
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

      log(`  ${allHits.length} contact(s) measured; shot types are left to the coaching pass`);
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

  // Smooth the skeletons before anything reads them.
  //
  // Here, rather than inside the pose step, because BOTH pose passes have to
  // be in hand first: the 5fps baseline and the high-rate bursts land in one
  // array, and a frame's neighbours may come from the other pass. Smoothing
  // either pass alone would miss exactly the frames that matter.
  //
  // Before the overlay and before the return, so the drawn skeletons, the
  // stored keypoints and the measured mechanics are all the same numbers --
  // an overlay that disagreed with the data it was rendered from would be the
  // worst possible debugging aid.
  const beforeSmoothing = poses.length;
  poses = smoothPoseFrames(poses);

  // Then the limb gate, and in this order on purpose: smoothing can rescue a
  // joint that was only slightly off, so gating first would throw away
  // keypoints the median was about to fix. Gating second only ever sees what
  // survived, and drops what is still geometrically impossible.
  const limbGate = gateImplausibleLimbs(poses);
  poses = limbGate.frames;
  if (beforeSmoothing > 0) {
    log(`pose: ${beforeSmoothing} frames smoothed (3-point median within bursts); `
      + `${limbGate.stats.dropped} joint(s) dropped for stretching a limb past its own length`
      + (limbGate.stats.unmeasured ? ` (${limbGate.stats.unmeasured} bone(s) had too few samples to judge)` : ""));
  }

  // Positioning, which needs no ball at all.
  //
  // Logged rather than persisted for now: these are new numbers and the first
  // thing to establish is whether they are RIGHT on real footage, which
  // reading them off a run tells you without committing a schema to them. The
  // conversion to feet is frame-aware, so the values are comparable between
  // clips shot with different quad kinds -- which the raw court units are not.
  if (courtCalibration.confidence > 0) {
    const frame = courtFrameFor(courtCalibration.quadKind);
    const positions: PlayerPositions[] = movement.map((m) => ({
      playerId: m.playerId,
      samples: m.samples.map((s) => ({
        timestampSeconds: s.timestampSeconds, courtX: s.courtX, courtY: s.courtY,
      })),
    }));
    for (const p of positions) {
      if (p.samples.length === 0) continue;
      const z = zoneBreakdown(p.samples, frame);
      const side = majoritySide(p.samples, frame);
      log(`position ${p.playerId} (${side}): kitchen ${Math.round(z.kitchen * 100)}%, `
        + `transition ${Math.round(z.transition * 100)}%, back ${Math.round(z.back * 100)}% `
        + `of ${z.samples} samples`);
      const mate = partnerOf(p.playerId, positions, frame);
      if (mate) {
        const g = partnerGap(p.samples, mate.samples, frame);
        if (g.samples > 0) {
          log(`  partner gap with ${mate.playerId}: mean ${g.meanFeet}ft, max ${g.maxFeet}ft, `
            + `${Math.round(g.fractionWide * 100)}% of the time wider than 12ft`);
        }
      }
    }
  } else {
    log("position: skipped — no calibrated court, so court positions are unavailable");
  }

  // The overlay is rendered here, at the end, from the values the run actually
  // used -- after every fallback has been resolved, so it can never show a
  // court or a set of boundaries that lost.
  let debugVideoUrl: string | null = null;
  if (debugRenderEnabled() && input.debugId) {
    stage("overlay", "rendering the annotated overlay — the coaching read is written from it…");
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
  // The line this whole exercise exists for. Every claim about what makes a
  // run slow has so far been inferred from reading the code; this is the
  // stopwatch.
  log(`time: ${timer.summary()}`);
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
