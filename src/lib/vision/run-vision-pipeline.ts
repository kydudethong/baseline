import { getPhase2VisionProvider, playerDetectionIsLocal } from "./provider-v2";
import { analyzeMovementWithCalibration } from "./provider-v2";
import { detectFootworkFoundation } from "./events";
import { computeAppearanceSignaturesViaPython } from "./cv-scripts";
import type { BallDetection, BallTrackPoint, BallTrackStats } from "./ball";
import { courtFrameFor, sideOf as courtSideOf, type Shot } from "./shots";
import type { AnalysisStage } from "@/lib/db/types";
import { StageTimer } from "@/lib/analysis/stage-timer";
import { calibrationFromSetup, isPlausibleCourtQuad, playerGatePolygonPx, pointInPolygon, transformToCourtCoordinates } from "./court";
import type { ClusteredRally } from "./rallies";
import { netBandImagePx, netLineImagePx, type NetCrossing } from "./rallies-net";
import { debugRenderEnabled, renderDebugVideo } from "./debug-render";
import { smoothPoseFrames } from "./pose-smooth";
import { gateImplausibleLimbs } from "./pose-limbs";
import { majoritySide, partnerGap, partnerOf, zoneBreakdown, type PlayerPositions } from "./positioning";
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
  const ballTrack: VisionPipelineOutput["ballTrack"] = { points: [], stats: null, diagnostics: {}, rawDetections: [] };
  const shots: Shot[] = [];
  // Always empty now: crossings were rally evidence and nothing computes them.
  // Kept as a field so the overlay renderer's shape does not have to change.
  const netCrossings: NetCrossing[] = [];
  // Always 0: dead balls were counted by the segmenters that are gone.
  const deadBallCount = 0;
  const ballGatePx: Array<[number, number]> | null = null;
  // Hoisted so the overlay, which is rendered at the very end from the values
  // the run actually used, can draw what the paddle model and the audio gate
  // produced instead of only reporting counts in the log.
  // Hoisted so the overlay renderer at the end can draw the boundaries that
  // actually won, rather than whichever segmenter happened to run last.
  const ralliesUsed: ClusteredRally[] = [];
  const rallyOutput: AnalysisRallyOutput[] = [];
  // BALL TRACKING IS GONE, and with it contacts, shot records, swing mechanics
  // and the pose bursts that hung off them. What used to be ~300 lines here is
  // this comment.
  //
  // WHY, in the order the evidence arrived:
  //
  //  1. Its output was wrong often enough to poison everything downstream. Of
  //     five contact timestamps checked against the footage by a VLM, two were
  //     not strokes at all (a player bouncing the ball between points; a point
  //     that had already ended) and one was late by more than half a second.
  //     Every shot record, every swing measurement and every rally boundary
  //     was built on those timestamps.
  //
  //  2. It was the most expensive stage by far -- a full 1080p->720p proxy
  //     transcode, then Roboflow's `inference` package (which loads torch,
  //     ONNX Runtime and probes for Qwen-VL, SAM and gaze models it never
  //     uses), then detection over thousands of frames. On a 14-minute clip it
  //     was the only stage that never finished; court, players and pose
  //     together took 24 minutes and the ball stage killed the machine.
  //
  //  3. Nothing needs it any more. Gemini finds rallies and shots from the
  //     overlay, and reads technique from a high-frame-rate clip of each shot
  //     -- measured, on the same second of footage: at 1fps "no stroke is
  //     visible"; at 15fps "paddle open, contact at knee level, bend the knees
  //     more to get down to the level of the low bounce rather than swinging
  //     predominantly with the arm from an upright posture", high confidence.
  //     That is better than anything the contact-driven mechanics produced.
  //
  // What still happens here: court, player tracks, pose at VISION_FPS, and
  // movement. Those are measurements, and measurement is what this pipeline is
  // for now. Interpretation belongs to the coaching pass.
  knownLimitations.push(
    "Ball position is not tracked. Rally boundaries, shot types and technique are read from the "
    + "video by the coaching pass instead, which sees the stroke itself rather than inferring it "
    + "from where the ball was."
  );

  // The net line and band survive the ball's removal, because they are COURT
  // geometry and always were -- they happened to be computed inside the ball
  // block, which nearly took them out with it. The overlay draws both, and the
  // legend (which IS the prompt) tells the model what the band means: a ball
  // inside it cannot be assigned to a side, because from behind a baseline the
  // net stands between the camera and the far court. Dropping them would have
  // left the legend describing something no longer drawn.
  const netBandPx = netBandImagePx(courtCalibration, input.frameWidthPx, input.frameHeightPx);
  const netLinePx = netBandPx?.base
    ?? netLineImagePx(courtCalibration, input.frameWidthPx, input.frameHeightPx);

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
