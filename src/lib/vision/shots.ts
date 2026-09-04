/**
 * Shot classification — geometry first, learned models later.
 *
 * Given, per rally, the ordered paddle hits (who, when, where they stood),
 * the bounces between them (where the ball landed on the court plane) and
 * the ball's arc in between, every pickleball shot type is a definition
 * over a few physical quantities:
 *
 *   where it was hit from   (kitchen line / transition zone / back court)
 *   how fast it travelled   (metres per second, from court-plane distance / time)
 *   how high it went        (apex above the hit point, normalized image height)
 *   where it landed         (kitchen / mid / deep / out — court-plane via homography)
 *   did it bounce first     (groundstroke vs volley)
 *   what came before it     (a fast ball arriving makes a soft reply a reset, not a drop)
 *   its place in the rally  (1st = serve, 2nd = return, 3rd = the third shot)
 *
 * Writing the classifier as explicit rules over those quantities is what
 * makes the result checkable: every shot carries the features it was
 * decided on, so a wrong label can be traced to a wrong number rather than
 * to a black box. Thresholds live in one place (THRESHOLDS) so they can be
 * tuned against hand-labelled clips (see scripts/eval-shots.ts).
 *
 * Every shot also carries a confidence that degrades honestly: no ball seen
 * at the hit, no landing observed, no court calibration — each lowers it,
 * and the coaching layer is told to lean on the confident ones.
 */

import type { CourtCalibration, PlayerTrack } from "./phase2-types";
import type { AnalysisShotRow } from "@/lib/db/types";
import type { BallBounce, BallHit, BallTrackPoint } from "./ball";
import { computeHomography, applyHomography, type Homography } from "./homography";

export type ShotType =
  | "serve"
  | "return"
  | "third_shot_drop"
  | "third_shot_drive"
  | "dink"
  | "drop"
  | "reset"
  | "drive"
  | "volley"
  | "speed_up"
  | "overhead"
  | "lob"
  | "block"
  | "unknown";

export type ShotCategory = "serve_return" | "kitchen" | "offense" | "defense" | "transition" | "unknown";
export type CourtZone = "kitchen" | "transition" | "back" | "unknown";
export type LandingZone = "kitchen" | "mid" | "deep" | "out" | "unknown";
export type ShotOutcome = "in" | "net" | "out" | "unknown";

export interface Shot {
  rallyIdx: number;
  /** 0-based position in the rally: 0 = serve. */
  shotIdx: number;
  t: number;
  playerId: string | null;
  type: ShotType;
  category: ShotCategory;
  confidence: number;
  /** Hitter's feet in court units (see CourtFrame); null without calibration or player. */
  hitCourt: { x: number; y: number } | null;
  hitZone: CourtZone;
  landingCourt: { x: number; y: number } | null;
  landingZone: LandingZone;
  speedMpsApprox: number | null;
  /** How far the ball rose above the hit point, as a fraction of frame height. */
  arcNorm: number | null;
  /** Did the ball bounce on the hitter's side before this hit (groundstroke) — false = volley. */
  bouncedBefore: boolean | null;
  /** For the last shot of a rally: how the rally ended. "in" otherwise (the ball came back). */
  outcome: ShotOutcome;
  features: Record<string, number | string | boolean | null>;
}

export const SHOT_CATEGORY: Record<ShotType, ShotCategory> = {
  serve: "serve_return",
  return: "serve_return",
  third_shot_drop: "serve_return",
  third_shot_drive: "serve_return",
  dink: "kitchen",
  volley: "kitchen",
  speed_up: "offense",
  drive: "offense",
  overhead: "offense",
  drop: "transition",
  reset: "defense",
  block: "defense",
  lob: "defense",
  unknown: "unknown",
};

export const SHOT_LABEL: Record<ShotType, string> = {
  serve: "Serve",
  return: "Return",
  third_shot_drop: "Third-shot drop",
  third_shot_drive: "Third-shot drive",
  dink: "Dink",
  drop: "Drop",
  reset: "Reset",
  drive: "Drive",
  volley: "Volley",
  speed_up: "Speed-up",
  overhead: "Overhead",
  lob: "Lob",
  block: "Block",
  unknown: "Unclassified",
};

/* ------------------------------------------------------------------ */
/* Court frame — what the calibrated quadrilateral's unit square means  */
/* physically. The court detector returns ONE quad; whether that is the  */
/* near half (baseline-to-net, the documented assumption in movement.ts) */
/* or the full court is a deployment fact, set with COURT_QUAD.          */
/* ------------------------------------------------------------------ */

export interface CourtFrame {
  kind: "near-inplay" | "near-half" | "full";
  /** y (court units) of the net line. */
  netY: number;
  /** Kitchen depth (7 ft) in court-length units. */
  kitchenDepth: number;
  /** Half-court length (22 ft) in court-length units. */
  halfLength: number;
  /** Metres per court unit on each axis. */
  metresX: number;
  metresY: number;
}

/** Court units -> physical meaning, from what the detector said the quad is. */
export function courtFrameFor(kind: CourtFrame["kind"] | null | undefined): CourtFrame {
  if (kind === "full") {
    return { kind: "full", netY: 0.5, kitchenDepth: 7 / 44, halfLength: 0.5, metresX: 6.1, metresY: 13.41 };
  }
  if (kind === "near-inplay") {
    // Two-tone court: the quad is the near in-play surface, baseline (y=1)
    // to kitchen line (y=0). The net is 7 ft beyond the kitchen line, i.e.
    // y = -7/15; the far baseline is y = -29/15. Court y grows toward the
    // camera; 1 unit of y = 15 ft.
    return { kind: "near-inplay", netY: -7 / 15, kitchenDepth: 7 / 15, halfLength: 22 / 15, metresX: 6.1, metresY: 4.572 };
  }
  // Near half: top edge of the quad is the net, bottom edge the near
  // baseline. Court y grows toward the camera. Far court is y < 0.
  return { kind: "near-half", netY: 0, kitchenDepth: 7 / 22, halfLength: 1, metresX: 6.1, metresY: 6.71 };
}

export function courtFrameFromEnv(kind = process.env.COURT_QUAD ?? "near-half"): CourtFrame {
  return courtFrameFor(kind as CourtFrame["kind"]);
}

export function distanceFromNet(frame: CourtFrame, y: number): number {
  return Math.abs(y - frame.netY) / frame.halfLength; // 0 at the net, 1 at either baseline
}

export function sideOf(frame: CourtFrame, y: number): "near" | "far" {
  return y >= frame.netY ? "near" : "far";
}

export function metresBetween(frame: CourtFrame, a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot((a.x - b.x) * frame.metresX, (a.y - b.y) * frame.metresY);
}

/* ------------------------------------------------------------------ */
/* Thresholds — tune against labelled data, never in prose.             */
/* ------------------------------------------------------------------ */

export const THRESHOLDS = {
  /** Hitter within this many court-lengths of the net counts as "at the kitchen line" (7 ft + ~2.5 ft). */
  atLineDepth: 7 / 22 + 0.115,
  /** Beyond this depth the hitter is in the back court. */
  backDepth: 0.72,
  /** Landing zones, as distance from the net in half-court lengths. */
  landKitchen: 7 / 22,
  landMid: 0.68,
  landDeep: 1.06,
  /** Sideline tolerance in court-width units. */
  sideTolerance: 0.06,
  /** Average horizontal ball speed, m/s. */
  dinkMax: 4.6,
  softMax: 8.5,
  driveMin: 9.5,
  /** Apex rise above the hit point (fraction of frame height) that reads as a lob. */
  lobArc: 0.11,
  /** Minimum ball-track coverage between two hits before speed/arc are trusted. */
  minTrackCoverage: 0.35,
  /** Faster than any pickleball has ever been hit (~35 m/s = 78 mph) — a geometry error, not a shot. */
  maxPlausibleSpeed: 35,
};

/* ------------------------------------------------------------------ */

export interface RallyShotInput {
  rallyIdx: number;
  startS: number;
  endS: number;
  hits: BallHit[];
  bounces: BallBounce[];
  ballPoints: BallTrackPoint[];
}

export interface ClassifyContext {
  calibration: CourtCalibration;
  frame: CourtFrame;
  frameWidthPx: number;
  frameHeightPx: number;
  playerTracks: PlayerTrack[];
}

function homographyFor(ctx: ClassifyContext): Homography | null {
  const c = ctx.calibration.cornersImagePx;
  if (!c || ctx.calibration.confidence <= 0) return null;
  return computeHomography(
    [c.topLeft, c.topRight, c.bottomLeft, c.bottomRight],
    [[0, 0], [1, 0], [0, 1], [1, 1]]
  );
}

function toCourt(h: Homography | null, ctx: ClassifyContext, p: { x: number; y: number } | null): { x: number; y: number } | null {
  if (!h || !p) return null;
  const [cx, cy] = applyHomography(h, [p.x * ctx.frameWidthPx, p.y * ctx.frameHeightPx]);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  // Far-court extrapolation is legitimate for a planar homography but is
  // numerically soft: from a low camera behind the baseline the far half
  // sits near the horizon, so a pixel there is feet of court. Keep the
  // near side tight; give the far side a wide run-off (positions there are
  // coarse, and landingZone() treats them as such) and drop only what is
  // clearly nowhere near the court.
  const f = ctx.frame;
  const farBaselineY = f.netY - f.halfLength;
  const nearBaselineY = f.netY + f.halfLength;
  const maxY = nearBaselineY + 0.25 * f.halfLength;
  const minY = farBaselineY - 1.5 * f.halfLength;
  if (cx < -0.6 || cx > 1.6 || cy < minY || cy > maxY) return null;
  return { x: Math.round(cx * 1000) / 1000, y: Math.round(cy * 1000) / 1000 };
}

function hitZone(frame: CourtFrame, court: { x: number; y: number } | null): CourtZone {
  if (!court) return "unknown";
  const d = distanceFromNet(frame, court.y);
  if (d <= THRESHOLDS.atLineDepth) return "kitchen";
  if (d <= THRESHOLDS.backDepth) return "transition";
  return "back";
}

function landingZone(frame: CourtFrame, court: { x: number; y: number } | null): LandingZone {
  if (!court) return "unknown";
  const d = distanceFromNet(frame, court.y);
  // The far half is coarse from a baseline camera (see toCourt): an "out"
  // call there needs a much bigger margin than on the near side, where
  // the calibration is measured directly.
  const far = sideOf(frame, court.y) === "far";
  const sideTol = far ? 0.25 : THRESHOLDS.sideTolerance;
  const deepTol = far ? 1.6 : THRESHOLDS.landDeep;
  if (court.x < -sideTol || court.x > 1 + sideTol || d > deepTol) return "out";
  if (d <= THRESHOLDS.landKitchen) return "kitchen";
  if (d <= THRESHOLDS.landMid) return "mid";
  return "deep";
}

/** The net's image-space y at a given x: project the net line (court y = netY) through the homography. */
function netImageY(ctx: ClassifyContext, xNorm: number): number | null {
  const c = ctx.calibration.cornersImagePx;
  if (!c) return null;
  const inv = computeHomography(
    [[0, 0], [1, 0], [0, 1], [1, 1]],
    [c.topLeft, c.topRight, c.bottomLeft, c.bottomRight]
  );
  if (!inv) return null;
  // Find the net's image y under the ball's image x by sampling the net line.
  let best: number | null = null;
  let bestDx = Infinity;
  for (let i = 0; i <= 20; i++) {
    const [px, py] = applyHomography(inv, [i / 20, ctx.frame.netY]);
    const dx = Math.abs(px / ctx.frameWidthPx - xNorm);
    if (dx < bestDx) {
      bestDx = dx;
      best = py / ctx.frameHeightPx;
    }
  }
  return best;
}

/**
 * Classify every hit of one rally. Hits are processed in order so each
 * shot can see the one before it (the "was I under pressure" signal).
 */
export function classifyRally(input: RallyShotInput, ctx: ClassifyContext): Shot[] {
  const h = homographyFor(ctx);
  const frame = ctx.frame;
  const hits = [...input.hits].sort((a, b) => a.t - b.t);
  const bounces = [...input.bounces].sort((a, b) => a.t - b.t);
  const shots: Shot[] = [];
  const calibrationFactor = ctx.calibration.confidence > 0 ? 0.7 + 0.3 * Math.min(1, ctx.calibration.confidence) : 0.5;

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const prevHit = i > 0 ? hits[i - 1] : null;
    const nextHit = i < hits.length - 1 ? hits[i + 1] : null;
    const windowEnd = nextHit ? nextHit.t : input.endS;

    const hitCourt = toCourt(h, ctx, hit.playerFeet);
    const zone = hitZone(frame, hitCourt);
    const hitterSide = hitCourt ? sideOf(frame, hitCourt.y) : null;

    // Bounce before this hit (on the hitter's side, after the previous hit) => groundstroke.
    const bounceBefore = prevHit
      ? bounces.find((b) => b.t > prevHit.t + 0.05 && b.t < hit.t - 0.03 && sideMatches(h, ctx, b, hitterSide))
      : bounces.find((b) => b.t < hit.t - 0.03 && b.t > input.startS);
    const bouncedBefore = prevHit ? Boolean(bounceBefore) : null;

    // Landing after this hit: first bounce before the next hit, on the other side.
    const landing = bounces.find((b) => b.t > hit.t + 0.05 && b.t < windowEnd - 0.02 && sideMatches(h, ctx, b, hitterSide === "near" ? "far" : hitterSide === "far" ? "near" : null));
    const landingCourt = toCourt(h, ctx, landing ? { x: landing.x, y: landing.y } : null);
    const landZone = landingZone(frame, landingCourt);

    // Ball arc and speed between this hit and its landing (or the next hit).
    const seg = input.ballPoints.filter((p) => p.t >= hit.t && p.t <= (landing ? landing.t : windowEnd));
    const expectedFrames = Math.max(1, ((landing ? landing.t : windowEnd) - hit.t) * 30);
    const segCoverage = seg.filter((p) => !p.interpolated).length / expectedFrames;
    let arcNorm: number | null = null;
    if (hit.ball && seg.length >= 3 && segCoverage >= THRESHOLDS.minTrackCoverage) {
      const apexY = Math.min(...seg.map((p) => p.y));
      arcNorm = Math.round((hit.ball.y - apexY) * 1000) / 1000;
    }
    let speed: number | null = null;
    let speedBasis = "none";
    if (hitCourt && landingCourt && landing && landing.t - hit.t > 0.08) {
      speed = metresBetween(frame, hitCourt, landingCourt) / (landing.t - hit.t);
      speedBasis = "hit-to-landing";
    } else if (hitCourt && nextHit) {
      const nextCourt = toCourt(h, ctx, nextHit.playerFeet);
      if (nextCourt && nextHit.t - hit.t > 0.08) {
        speed = metresBetween(frame, hitCourt, nextCourt) / (nextHit.t - hit.t);
        speedBasis = "hit-to-next-hit";
      }
    }
    // Two consecutive contacts by the same player can't happen in real
    // play — it's an attribution error (a track swap, or the ball read
    // near the wrong player). Keep the type but don't trust a speed that
    // was measured between "this player" and "this player".
    const sideConflict = Boolean(prevHit && hit.playerId !== null && prevHit.playerId === hit.playerId);
    if (sideConflict && speedBasis === "hit-to-next-hit") {
      speed = null;
      speedBasis = "none";
    }
    if (speed !== null && speed > THRESHOLDS.maxPlausibleSpeed) {
      speed = null;
      speedBasis = "none";
    }
    if (speed !== null) speed = Math.round(speed * 10) / 10;
    const farLanding = landingCourt ? sideOf(frame, landingCourt.y) === "far" : false;

    const prevShot = shots[i - 1] ?? null;
    const underPressure = Boolean(prevShot && prevShot.speedMpsApprox !== null && prevShot.speedMpsApprox >= THRESHOLDS.driveMin);

    const { type, why } = decide({
      idx: i,
      zone,
      landZone,
      speed,
      arcNorm,
      bouncedBefore,
      overhead: hit.overhead,
      underPressure,
    });

    // Outcome — only the last shot of a rally ends it.
    let outcome: ShotOutcome = nextHit ? "in" : "unknown";
    if (!nextHit) {
      if (landZone === "out") outcome = "out";
      else if (landZone !== "unknown") outcome = "in";
      else if (hit.ball) {
        const after = input.ballPoints.filter((p) => p.t > hit.t && p.t <= windowEnd && !p.interpolated);
        const last = after[after.length - 1];
        const netY = last ? netImageY(ctx, last.x) : null;
        if (last && netY !== null && Math.abs(last.y - netY) < 0.04) outcome = "net";
      }
    }

    let confidence = hit.confidence * calibrationFactor;
    if (!hitCourt) confidence *= 0.7;
    if (!landing && i < hits.length - 1) confidence *= 0.85;
    if (speed === null) confidence *= 0.8;
    if (sideConflict) confidence *= 0.6;
    if (farLanding) confidence *= 0.85; // far-court positions are coarse from a baseline camera
    if (type === "unknown") confidence *= 0.5;
    confidence = Math.round(Math.max(0.05, Math.min(0.97, confidence)) * 100) / 100;

    shots.push({
      rallyIdx: input.rallyIdx,
      shotIdx: i,
      t: Math.round(hit.t * 100) / 100,
      playerId: hit.playerId,
      type,
      category: SHOT_CATEGORY[type],
      confidence,
      hitCourt,
      hitZone: zone,
      landingCourt,
      landingZone: landZone,
      speedMpsApprox: speed,
      arcNorm,
      bouncedBefore,
      outcome,
      features: {
        why,
        speedBasis,
        segCoverage: Math.round(segCoverage * 100) / 100,
        underPressure,
        sideConflict,
        farLanding,
        hitSource: hit.source,
        overhead: hit.overhead,
        landingT: landing ? Math.round(landing.t * 100) / 100 : null,
      },
    });
  }
  return shots;
}

function sideMatches(h: Homography | null, ctx: ClassifyContext, b: BallBounce, side: "near" | "far" | null): boolean {
  if (!side) return true; // no hitter position — accept any bounce
  const c = toCourt(h, ctx, { x: b.x, y: b.y });
  if (!c) return true;
  return sideOf(ctx.frame, c.y) === side;
}

interface DecideInput {
  idx: number;
  zone: CourtZone;
  landZone: LandingZone;
  speed: number | null;
  arcNorm: number | null;
  bouncedBefore: boolean | null;
  overhead: boolean | null;
  underPressure: boolean;
}

/** The rule table. Order matters — earlier rules are the more specific ones. */
export function decide(f: DecideInput): { type: ShotType; why: string } {
  const T = THRESHOLDS;
  const fast = f.speed !== null && f.speed >= T.driveMin;
  const soft = f.speed !== null && f.speed <= T.softMax;
  const dinkSpeed = f.speed !== null && f.speed <= T.dinkMax;
  const lobby = f.arcNorm !== null && f.arcNorm >= T.lobArc;

  if (f.idx === 0) return { type: "serve", why: "first contact of the rally" };
  if (f.idx === 1) return { type: "return", why: "second contact of the rally" };

  if (f.overhead && (fast || f.speed === null)) return { type: "overhead", why: "wrist above shoulder at contact, fast ball" };

  if (lobby && (f.landZone === "deep" || f.landZone === "unknown") && !fast) {
    return { type: "lob", why: `apex ${f.arcNorm} of frame height above contact, landed deep` };
  }

  if (f.idx === 2) {
    if (fast) return { type: "third_shot_drive", why: `third shot at ${f.speed} m/s` };
    if (soft && (f.landZone === "kitchen" || f.landZone === "mid" || f.landZone === "unknown")) {
      return { type: "third_shot_drop", why: `third shot, soft (${f.speed} m/s) toward the kitchen` };
    }
  }

  if (fast) {
    if (f.zone === "kitchen") return { type: "speed_up", why: `${f.speed} m/s from the kitchen line` };
    return { type: "drive", why: `${f.speed} m/s from the ${f.zone === "unknown" ? "court" : f.zone}` };
  }

  if (f.zone === "kitchen") {
    if (f.underPressure && soft) return { type: "block", why: "soft reply at the line to a fast incoming ball" };
    if (f.landZone === "kitchen" && (dinkSpeed || f.speed === null)) return { type: "dink", why: "kitchen line to kitchen, dink speed" };
    if (f.bouncedBefore === false && f.speed !== null) return { type: "volley", why: "taken out of the air at the line" };
    if (dinkSpeed) return { type: "dink", why: "dink speed from the kitchen line" };
    if (f.bouncedBefore === false) return { type: "volley", why: "out of the air at the line" };
    return { type: "dink", why: "kitchen-line exchange" };
  }

  if (soft && (f.landZone === "kitchen" || f.landZone === "mid")) {
    if (f.zone === "transition" || f.underPressure) return { type: "reset", why: "soft ball into the kitchen from mid-court / under pressure" };
    if (f.zone === "back") return { type: "drop", why: "soft ball into the kitchen from the back court" };
  }

  if (f.speed !== null && f.speed > T.softMax) return { type: "drive", why: `${f.speed} m/s, medium pace from the ${f.zone}` };
  if (soft && f.zone !== "unknown") return { type: f.underPressure ? "reset" : "drop", why: "soft ball from behind the line" };

  return { type: "unknown", why: "not enough ball data around this contact" };
}

/* ------------------------------------------------------------------ */
/* Aggregation for the coaching layer and the UI.                        */
/* ------------------------------------------------------------------ */

export interface ShotMix {
  total: number;
  classified: number;
  byType: Partial<Record<ShotType, number>>;
  byCategory: Partial<Record<ShotCategory, number>>;
  /** Rally-ending shots by this player: winners (in, unreturned) vs errors (net/out). */
  endings: { winners: number; errorsNet: number; errorsOut: number };
  thirdShot: { drops: number; dropsIntoKitchen: number; drives: number };
  dinks: { count: number; intoKitchen: number };
  serves: { count: number; in: number; out: number };
  returns: { count: number; deep: number };
  avgDriveSpeedMps: number | null;
}

export function summarizeShots(shots: Shot[], playerIds: Set<string> | null): ShotMix {
  const mine = playerIds ? shots.filter((s) => s.playerId !== null && playerIds.has(s.playerId)) : shots;
  const byType: ShotMix["byType"] = {};
  const byCategory: ShotMix["byCategory"] = {};
  const endings = { winners: 0, errorsNet: 0, errorsOut: 0 };
  const thirdShot = { drops: 0, dropsIntoKitchen: 0, drives: 0 };
  const dinks = { count: 0, intoKitchen: 0 };
  const serves = { count: 0, in: 0, out: 0 };
  const returns = { count: 0, deep: 0 };
  const driveSpeeds: number[] = [];

  for (const s of mine) {
    byType[s.type] = (byType[s.type] ?? 0) + 1;
    byCategory[s.category] = (byCategory[s.category] ?? 0) + 1;
    if (s.outcome === "net") endings.errorsNet += 1;
    else if (s.outcome === "out") endings.errorsOut += 1;
    else if (s.outcome === "in" && s.shotIdx >= 0 && isRallyEnder(s, shots)) endings.winners += 1;
    if (s.type === "third_shot_drop") {
      thirdShot.drops += 1;
      if (s.landingZone === "kitchen") thirdShot.dropsIntoKitchen += 1;
    }
    if (s.type === "third_shot_drive") thirdShot.drives += 1;
    if (s.type === "dink") {
      dinks.count += 1;
      if (s.landingZone === "kitchen") dinks.intoKitchen += 1;
    }
    if (s.type === "serve") {
      serves.count += 1;
      if (s.landingZone === "out") serves.out += 1;
      else if (s.landingZone !== "unknown") serves.in += 1;
    }
    if (s.type === "return") {
      returns.count += 1;
      if (s.landingZone === "deep") returns.deep += 1;
    }
    if ((s.type === "drive" || s.type === "third_shot_drive" || s.type === "speed_up") && s.speedMpsApprox !== null) {
      driveSpeeds.push(s.speedMpsApprox);
    }
  }

  return {
    total: mine.length,
    classified: mine.filter((s) => s.type !== "unknown").length,
    byType,
    byCategory,
    endings,
    thirdShot,
    dinks,
    serves,
    returns,
    avgDriveSpeedMps: driveSpeeds.length ? Math.round((driveSpeeds.reduce((a, b) => a + b, 0) / driveSpeeds.length) * 10) / 10 : null,
  };
}

function isRallyEnder(s: Shot, all: Shot[]): boolean {
  return !all.some((o) => o.rallyIdx === s.rallyIdx && o.shotIdx > s.shotIdx);
}

/** analysis_shots row -> Shot (the DB stores the same fields, loosely typed). */
export function shotFromRow(r: AnalysisShotRow): Shot {
  return {
    rallyIdx: r.rally_idx,
    shotIdx: r.shot_idx,
    t: Number(r.timestamp_s),
    playerId: r.player_label,
    type: r.shot_type as ShotType,
    category: r.category as ShotCategory,
    confidence: Number(r.confidence),
    hitCourt: (r.hit_court as Shot["hitCourt"]) ?? null,
    hitZone: r.hit_zone as CourtZone,
    landingCourt: (r.landing_court as Shot["landingCourt"]) ?? null,
    landingZone: r.landing_zone as LandingZone,
    speedMpsApprox: r.speed_mps_approx === null ? null : Number(r.speed_mps_approx),
    arcNorm: r.arc_norm === null ? null : Number(r.arc_norm),
    bouncedBefore: r.bounced_before,
    outcome: r.outcome as ShotOutcome,
    features: (r.features as Shot["features"]) ?? {},
  };
}
