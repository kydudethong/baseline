// Facts assembly: turns Rally IQ's own raw CV output (player tracks, pose
// keypoints, movement metrics, audio-onset events) into the compact,
// honesty-scored JSON the coaching LLM prompts (see prompts.ts) actually
// read. This is the module the 0005_coaching_layer.sql migration's header
// comment refers to — nothing here measures anything the CV pipeline
// doesn't actually see; everything below is either a genuine geometric
// measurement (knee angle) or an explicitly-labeled, confidence-capped
// proxy/heuristic (paddle position, contact side, rally boundaries).
//
// What this deliberately does NOT do: classify shot type. No signal
// available here (body pose, audio onset timing, tracked position) tells
// drive from drop from dink, and guessing would corrupt every downstream
// coaching claim built on it — consistent with how Rally IQ's own
// unknown_shot event naming already treats this.

import type {
  AnalysisEventRow,
  MovementMetricRow,
  PlayerKeypointRow,
  PlayerTrackRow,
} from "@/lib/db/types";
import type { CocoKeypointName, PlayerTrackPoint, PoseKeypoint } from "@/lib/vision/phase2-types";

/* ------------------------------------------------------------------ */
/* Rally boundary clustering — ported from Baseline's segment.ts        */
/* clusterRallies(). There it clustered onsets found by this app's own  */
/* spectral-flux detector; here the onsets are Rally IQ's own            */
/* unknown_shot audio events, already detected upstream (events.ts).    */
/* Same gap-based grouping logic, same default parameters.              */
/* ------------------------------------------------------------------ */

interface ClusterParams {
  gapS: number;
  minShots: number;
  minDurationS: number;
  leadS: number;
  tailS: number;
}

const CLUSTER_PARAMS: ClusterParams = {
  gapS: 3.5,
  minShots: 4,
  minDurationS: 1.5,
  leadS: 0.5,
  tailS: 0.8,
};

interface ClusteredRally {
  idx: number;
  startS: number;
  endS: number;
  contacts: number[];
}

function clusterRalliesWithContacts(onsets: number[], params: ClusterParams): ClusteredRally[] {
  if (onsets.length === 0) return [];
  const sorted = [...onsets].sort((a, b) => a - b);

  const groups: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const group = groups[groups.length - 1];
    if (sorted[i] - group[group.length - 1] > params.gapS) groups.push([sorted[i]]);
    else group.push(sorted[i]);
  }

  const rallies: ClusteredRally[] = [];
  for (const group of groups) {
    if (group.length < params.minShots) continue;
    const startS = Math.max(0, group[0] - params.leadS);
    const endS = group[group.length - 1] + params.tailS;
    if (endS - startS < params.minDurationS) continue;
    rallies.push({ idx: rallies.length + 1, startS, endS, contacts: group });
  }
  return rallies;
}

/* ------------------------------------------------------------------ */
/* Court-side grouping — which tracked players share Rally IQ's own      */
/* "self" track's half of the court, used both for contact-side          */
/* attribution and to scope stance/paddle facts to the player asking.    */
/* ------------------------------------------------------------------ */

interface TrackData {
  playerId: string;
  points: PlayerTrackPoint[];
}

/**
 * Rally IQ's tracker has no re-identification (see tracker.ts's own
 * documented limitation) — a real player who briefly leaves frame, gets
 * occluded, or has a missed detection can resume under a brand-new
 * player_N label. So "which one is you" is realistically a SET of labels,
 * not one. This collapses every track whose label is in that set into a
 * single synthetic SELF_ID entry (points merged and time-sorted) before
 * grouping/attribution run, so the rest of this module can stay written in
 * terms of one self track.
 */
function mergeSelfFragments(tracks: TrackData[], selfLabels: Set<string>): TrackData[] {
  const selfPoints = tracks
    .filter((t) => selfLabels.has(t.playerId))
    .flatMap((t) => t.points)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);
  const others = tracks.filter((t) => !selfLabels.has(t.playerId));
  if (selfPoints.length === 0) return others;
  return [{ playerId: SELF_ID, points: selfPoints }, ...others];
}

function avgDepth(points: PlayerTrackPoint[]): { value: number; fromCourtCoords: boolean } | null {
  const courtYs = points.map((p) => p.courtPosition?.y).filter((y): y is number => y !== null && y !== undefined);
  if (courtYs.length > 0) {
    return { value: courtYs.reduce((a, b) => a + b, 0) / courtYs.length, fromCourtCoords: true };
  }
  // Fallback: image-space feet position. Weaker signal (camera perspective,
  // not a calibrated court plane) — callers are told when this path is used.
  const imageYs = points.map((p) => p.boxImageNorm.y + p.boxImageNorm.height);
  if (imageYs.length === 0) return null;
  return { value: imageYs.reduce((a, b) => a + b, 0) / imageYs.length, fromCourtCoords: false };
}

/** Sentinel playerId standing in for all of the tagged player's track
 *  fragments, merged into one entry before grouping/attribution run — see
 *  mergeSelfFragments() below. */
const SELF_ID = "__self__";

function groupSides(
  tracks: TrackData[],
  selfPlayerLabel: string
): { selfSide: Set<string>; opponentSide: Set<string>; usedImageFallback: boolean } {
  const depths = tracks
    .map((t) => {
      const d = avgDepth(t.points);
      return d ? { playerId: t.playerId, depth: d.value, fromCourtCoords: d.fromCourtCoords } : null;
    })
    .filter((d): d is { playerId: string; depth: number; fromCourtCoords: boolean } => d !== null)
    .sort((a, b) => a.depth - b.depth);

  const usedImageFallback = depths.some((d) => !d.fromCourtCoords);

  if (depths.length < 2) {
    // Not enough position data to split at all — everyone but self counts
    // as "unknown side", not "opponent", so callers don't overclaim.
    return { selfSide: new Set([selfPlayerLabel]), opponentSide: new Set(), usedImageFallback };
  }

  // Split at the single largest gap in sorted depth — robust to however
  // many players ended up with valid position data, without assuming a
  // fixed 2v2/1v1 count.
  let splitAt = 1;
  let biggestGap = -Infinity;
  for (let i = 1; i < depths.length; i++) {
    const gap = depths[i].depth - depths[i - 1].depth;
    if (gap > biggestGap) {
      biggestGap = gap;
      splitAt = i;
    }
  }
  const near = new Set(depths.slice(0, splitAt).map((d) => d.playerId));
  const far = new Set(depths.slice(splitAt).map((d) => d.playerId));

  if (near.has(selfPlayerLabel)) return { selfSide: near, opponentSide: far, usedImageFallback };
  if (far.has(selfPlayerLabel)) return { selfSide: far, opponentSide: near, usedImageFallback };
  return { selfSide: new Set([selfPlayerLabel]), opponentSide: new Set(), usedImageFallback };
}

/* ------------------------------------------------------------------ */
/* Contact-side attribution — which side (self's team vs. opponent's)    */
/* most likely produced each audio contact. Motion energy (the same      */
/* bbox-position-change signal events.ts already uses for split-step     */
/* candidates) near the contact timestamp is the only signal available;  */
/* it identifies a SIDE, never an individual player within a team — see  */
/* the 0005 migration's header comment for why that's the honest limit.  */
/* ------------------------------------------------------------------ */

// Wide enough to comfortably contain a full swing-motion burst (prep +
// contact + follow-through) around a contact timestamp even a few tenths
// of a second off, at the default VISION_FPS=5 sampling (~0.2s between
// points) — a narrower window risks the two points that actually carry the
// motion (the transition in and out of the burst) landing just outside it,
// leaving only the flat interior and silently reading as "no motion".
const CONTACT_WINDOW_S = 0.75;
const WINDOW_EPSILON = 1e-6; // floating-point safety margin on the boundary check

function motionEnergyNear(points: PlayerTrackPoint[], t: number, windowS: number): number {
  const window = points
    .filter((p) => Math.abs(p.timestampSeconds - t) <= windowS + WINDOW_EPSILON)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);
  let energy = 0;
  for (let i = 1; i < window.length; i++) {
    const a = window[i - 1].boxImageNorm;
    const b = window[i].boxImageNorm;
    const acx = a.x + a.width / 2, acy = a.y + a.height;
    const bcx = b.x + b.width / 2, bcy = b.y + b.height;
    energy += Math.hypot(bcx - acx, bcy - acy) + Math.abs(b.height - a.height);
  }
  return energy;
}

interface ContactAttribution {
  tS: number;
  side: "self" | "opponent" | "unknown";
  confidence: number;
}

function attributeContacts(
  contacts: number[],
  tracks: TrackData[],
  selfSide: Set<string>,
  opponentSide: Set<string>
): ContactAttribution[] {
  const byId = new Map(tracks.map((t) => [t.playerId, t]));

  return contacts.map((t) => {
    const selfEnergy = [...selfSide].reduce((sum, id) => sum + motionEnergyNear(byId.get(id)?.points ?? [], t, CONTACT_WINDOW_S), 0);
    const oppEnergy = [...opponentSide].reduce((sum, id) => sum + motionEnergyNear(byId.get(id)?.points ?? [], t, CONTACT_WINDOW_S), 0);

    const total = selfEnergy + oppEnergy;
    if (total < 1e-6 || (selfSide.size === 0 && opponentSide.size === 0)) {
      return { tS: t, side: "unknown", confidence: 0 };
    }

    const winner = selfEnergy >= oppEnergy ? "self" : "opponent";
    const margin = Math.abs(selfEnergy - oppEnergy) / total;
    // Capped well below "certain" — this is a relative-motion heuristic on
    // 2D body tracking, not a verified assignment.
    const confidence = Math.round((0.3 + margin * 0.4) * 100) / 100;
    return { tS: t, side: winner, confidence };
  });
}

/* ------------------------------------------------------------------ */
/* Stance (knee angle) and paddle-position proxy from pose keypoints.    */
/* Knee angle is a genuine geometric measurement; wrist-vs-shoulder       */
/* height is an explicit PROXY for paddle position — no paddle is ever   */
/* detected, YOLOv8n-pose is body-only.                                  */
/* ------------------------------------------------------------------ */

const KEYPOINT_MIN_CONFIDENCE = 0.3;

function findKp(keypoints: PoseKeypoint[], name: CocoKeypointName): PoseKeypoint | undefined {
  return keypoints.find((k) => k.name === name);
}

function usable(kp: PoseKeypoint | undefined): kp is PoseKeypoint & { xNorm: number; yNorm: number } {
  return !!kp && kp.xNorm !== null && kp.yNorm !== null && (kp.confidence ?? 0) >= KEYPOINT_MIN_CONFIDENCE;
}

/** Angle at the knee, in degrees. 180 = straight leg, smaller = more bend. */
function kneeAngleDeg(hip: PoseKeypoint, knee: PoseKeypoint, ankle: PoseKeypoint): number | null {
  if (!usable(hip) || !usable(knee) || !usable(ankle)) return null;
  const v1 = { x: hip.xNorm! - knee.xNorm!, y: hip.yNorm! - knee.yNorm! };
  const v2 = { x: ankle.xNorm! - knee.xNorm!, y: ankle.yNorm! - knee.yNorm! };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const mag = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
  if (mag < 1e-9) return null;
  const cos = Math.max(-1, Math.min(1, dot / mag));
  return (Math.acos(cos) * 180) / Math.PI;
}

interface PoseSample {
  tS: number;
  kneeAngleDeg: number | null;
  /** shoulderY - wristY in normalized frame units; positive = wrist above shoulder. */
  wristShoulderDelta: number | null;
}

function poseSample(keypoints: PoseKeypoint[]): PoseSample | null {
  const lHip = findKp(keypoints, "left_hip"), rHip = findKp(keypoints, "right_hip");
  const lKnee = findKp(keypoints, "left_knee"), rKnee = findKp(keypoints, "right_knee");
  const lAnkle = findKp(keypoints, "left_ankle"), rAnkle = findKp(keypoints, "right_ankle");
  const angles = [
    lHip && lKnee && lAnkle ? kneeAngleDeg(lHip, lKnee, lAnkle) : null,
    rHip && rKnee && rAnkle ? kneeAngleDeg(rHip, rKnee, rAnkle) : null,
  ].filter((a): a is number => a !== null);
  const kneeAngle = angles.length > 0 ? angles.reduce((a, b) => a + b, 0) / angles.length : null;

  const lShoulder = findKp(keypoints, "left_shoulder"), rShoulder = findKp(keypoints, "right_shoulder");
  const lWrist = findKp(keypoints, "left_wrist"), rWrist = findKp(keypoints, "right_wrist");
  const shoulderYs = [lShoulder, rShoulder].filter(usable).map((k) => k.yNorm!);
  const wristYs = [lWrist, rWrist].filter(usable).map((k) => k.yNorm!);
  const shoulderY = shoulderYs.length > 0 ? shoulderYs.reduce((a, b) => a + b, 0) / shoulderYs.length : null;
  // Whichever wrist is raised highest (smallest yNorm) drives the proxy —
  // a paddle held ready is usually the more-raised hand, and averaging both
  // wrists would wash out a normal one-paddle-up/one-paddle-down stance.
  const wristY = wristYs.length > 0 ? Math.min(...wristYs) : null;
  const wristShoulderDelta = shoulderY !== null && wristY !== null ? shoulderY - wristY : null;

  if (kneeAngle === null && wristShoulderDelta === null) return null;
  return { tS: 0, kneeAngleDeg: kneeAngle, wristShoulderDelta };
}

const PADDLE_RAISED_THRESHOLD = 0.03;
const KNEE_BENT_THRESHOLD_DEG = 165;

/* ------------------------------------------------------------------ */
/* Public shapes                                                        */
/* ------------------------------------------------------------------ */

export interface CoachingFactsRally {
  rally_number: number;
  start_s: number;
  end_s: number;
  /** Clustered audio-contact count — an approximate shot count, not a verified one. */
  shots: number;
  contacts: Array<{ t_s: number; side: "self" | "opponent" | "unknown"; confidence: number }>;
  self_stance: { samples: number; avg_knee_bend_deg: number | null; bent_fraction: number | null } | null;
  self_paddle_proxy: { samples: number; raised_fraction: number | null; lowered_fraction: number | null } | null;
}

export interface CourtCoverageBounds {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface CoachingFacts {
  /** Every track label merged into "you" for this analysis — see mergeSelfFragments(). */
  self_player_labels: string[];
  rallies: CoachingFactsRally[];
  movement_summary: {
    distance_covered_meters_approx: number | null;
    average_speed_court_units_s: number | null;
    max_speed_court_units_s: number | null;
    court_coverage_bounds: CourtCoverageBounds | null;
  } | null;
  known_limitations: string[];
}

export interface BuildCoachingFactsInput {
  /** Every player_N label the self-tag step identified as "you" for this clip. */
  selfPlayerLabels: string[];
  tracks: PlayerTrackRow[];
  keypoints: PlayerKeypointRow[];
  movement: MovementMetricRow[];
  events: AnalysisEventRow[];
}

export function buildCoachingFacts(input: BuildCoachingFactsInput): CoachingFacts {
  const knownLimitations: string[] = [
    "Shot type (drive/dink/drop/volley/serve) is not classified anywhere in this data — no available " +
      "signal (body pose, audio timing, tracked position) distinguishes them reliably.",
    "Rally boundaries are approximated by clustering paddle-contact audio events (a gap of 3.5s or more " +
      "ends a rally); they are not read from game state or score.",
    "Paddle position is a PROXY — wrist height relative to shoulder from body pose — no paddle is ever " +
      "detected or tracked directly.",
  ];

  const selfLabels = new Set(input.selfPlayerLabels);
  if (selfLabels.size > 1) {
    knownLimitations.push(
      `Rally IQ's player tracker has no re-identification, so the same real player can pick up a new label ` +
        `after any occlusion or missed detection. This analysis merges ${selfLabels.size} labels ` +
        `(${[...selfLabels].join(", ")}) as "you" — stance/paddle/movement facts below combine all of them, ` +
        "but a gap between fragments (e.g. between rallies) still means some real moments aren't attributed to any of them."
    );
  }

  const rawTrackData: TrackData[] = input.tracks.map((t) => ({
    playerId: t.player_label,
    points: (t.points as PlayerTrackPoint[] | null) ?? [],
  }));
  const trackData = mergeSelfFragments(rawTrackData, selfLabels);
  const selfTrack = trackData.find((t) => t.playerId === SELF_ID);
  if (!selfTrack) {
    knownLimitations.push(
      `None of the tagged player labels (${[...selfLabels].join(", ") || "none given"}) matched a player ` +
        "track — stance, paddle-proxy and movement facts below are all empty for this analysis."
    );
  }

  const { selfSide, opponentSide, usedImageFallback } = selfTrack
    ? groupSides(trackData, SELF_ID)
    : { selfSide: new Set<string>(), opponentSide: new Set<string>(), usedImageFallback: false };
  if (usedImageFallback) {
    knownLimitations.push(
      "Court calibration was unavailable for at least one tracked player, so near/far side grouping fell " +
        "back to raw image position rather than calibrated court coordinates — weaker signal."
    );
  }
  if (selfTrack && opponentSide.size === 0) {
    knownLimitations.push("No opposing-side player track was found; contact-side attribution can only ever say \"self\" or \"unknown\" for this analysis.");
  }

  // Audio contacts.
  const onsets = input.events
    .filter((e) => e.event_type === "unknown_shot")
    .map((e) => e.timestamp_s)
    .sort((a, b) => a - b);
  const clustered = clusterRalliesWithContacts(onsets, CLUSTER_PARAMS);
  if (clustered.length === 0) {
    knownLimitations.push("No audio-contact clusters met the minimum rally thresholds (>=4 contacts, >=1.5s) — no rallies could be segmented.");
  }

  // Pose keypoints, grouped by self player (any merged label) + rally window.
  const selfKeypoints = input.keypoints
    .filter((k) => selfLabels.has(k.player_label))
    .map((k) => ({ tS: k.timestamp_s, sample: poseSample((k.keypoints as PoseKeypoint[] | null) ?? []) }))
    .filter((k): k is { tS: number; sample: PoseSample } => k.sample !== null);

  const rallies: CoachingFactsRally[] = clustered.map((r) => {
    const contactAttrs = selfTrack
      ? attributeContacts(r.contacts, trackData, selfSide, opponentSide)
      : r.contacts.map((t) => ({ tS: t, side: "unknown" as const, confidence: 0 }));

    const samplesInRally = selfKeypoints.filter((k) => k.tS >= r.startS && k.tS <= r.endS);

    const kneeSamples = samplesInRally.filter((k) => k.sample.kneeAngleDeg !== null);
    const selfStance =
      kneeSamples.length > 0
        ? {
            samples: kneeSamples.length,
            avg_knee_bend_deg:
              Math.round((kneeSamples.reduce((a, k) => a + (k.sample.kneeAngleDeg ?? 0), 0) / kneeSamples.length) * 10) / 10,
            bent_fraction:
              Math.round((kneeSamples.filter((k) => (k.sample.kneeAngleDeg ?? 180) < KNEE_BENT_THRESHOLD_DEG).length / kneeSamples.length) * 100) / 100,
          }
        : null;

    const paddleSamples = samplesInRally.filter((k) => k.sample.wristShoulderDelta !== null);
    const selfPaddleProxy =
      paddleSamples.length > 0
        ? {
            samples: paddleSamples.length,
            raised_fraction:
              Math.round((paddleSamples.filter((k) => (k.sample.wristShoulderDelta ?? 0) > PADDLE_RAISED_THRESHOLD).length / paddleSamples.length) * 100) / 100,
            lowered_fraction:
              Math.round((paddleSamples.filter((k) => (k.sample.wristShoulderDelta ?? 0) < -PADDLE_RAISED_THRESHOLD).length / paddleSamples.length) * 100) / 100,
          }
        : null;

    return {
      rally_number: r.idx,
      start_s: Math.round(r.startS * 10) / 10,
      end_s: Math.round(r.endS * 10) / 10,
      shots: r.contacts.length,
      contacts: contactAttrs.map((c) => ({ t_s: Math.round(c.tS * 10) / 10, side: c.side, confidence: c.confidence })),
      self_stance: selfStance,
      self_paddle_proxy: selfPaddleProxy,
    };
  });

  // One movement_metrics row per original (pre-merge) fragment — combine
  // them rather than taking just one, for the same re-identification reason
  // as mergeSelfFragments() above.
  const selfMovementRows = input.movement.filter((m) => selfLabels.has(m.player_label));
  const movementSummary = combineMovementRows(selfMovementRows);
  if (selfMovementRows.length === 0) {
    knownLimitations.push("No movement metrics were found for any tagged player label — footwork/court-movement facts are empty for this analysis.");
  } else if (selfMovementRows.length > 1) {
    knownLimitations.push(
      `Footwork/movement facts below are summed across ${selfMovementRows.length} separately-tracked fragments ` +
        "of you, not one continuous track — average speed in particular is a rougher estimate than usual."
    );
  }

  return {
    self_player_labels: [...selfLabels],
    rallies,
    movement_summary: movementSummary,
    known_limitations: knownLimitations,
  };
}

function combineMovementRows(rows: MovementMetricRow[]): CoachingFacts["movement_summary"] {
  if (rows.length === 0) return null;

  const distances = rows.map((r) => r.distance_covered_meters_approx).filter((d): d is number => d !== null);
  const totalDistance = distances.length > 0 ? distances.reduce((a, b) => a + b, 0) : null;

  // No per-row duration is stored, so average speed across fragments is a
  // distance-weighted mean of each fragment's own average — an
  // approximation of an approximation, called out above when this path runs.
  const speeds = rows
    .map((r) => ({ speed: r.average_speed_court_units_s, weight: r.distance_covered_court_units ?? 0 }))
    .filter((s): s is { speed: number; weight: number } => s.speed !== null);
  const speedWeightTotal = speeds.reduce((a, s) => a + s.weight, 0);
  const averageSpeed =
    speeds.length > 0
      ? speedWeightTotal > 0
        ? speeds.reduce((a, s) => a + s.speed * s.weight, 0) / speedWeightTotal
        : speeds.reduce((a, s) => a + s.speed, 0) / speeds.length
      : null;

  const maxSpeeds = rows.map((r) => r.max_speed_court_units_s).filter((s): s is number => s !== null);
  const maxSpeed = maxSpeeds.length > 0 ? Math.max(...maxSpeeds) : null;

  const bounds = rows
    .map((r) => r.court_coverage_bounds as CourtCoverageBounds | null)
    .filter((b): b is CourtCoverageBounds => b !== null);
  const combinedBounds =
    bounds.length > 0
      ? {
          xMin: Math.min(...bounds.map((b) => b.xMin)),
          xMax: Math.max(...bounds.map((b) => b.xMax)),
          yMin: Math.min(...bounds.map((b) => b.yMin)),
          yMax: Math.max(...bounds.map((b) => b.yMax)),
        }
      : null;

  return {
    distance_covered_meters_approx: totalDistance !== null ? Math.round(totalDistance * 100) / 100 : null,
    average_speed_court_units_s: averageSpeed !== null ? Math.round(averageSpeed * 1000) / 1000 : null,
    max_speed_court_units_s: maxSpeed,
    court_coverage_bounds: combinedBounds,
  };
}
