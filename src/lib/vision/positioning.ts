/**
 * Where players stand, which is most of what separates levels in pickleball.
 *
 * These three measurements need NO BALL. That is the point of them: they come
 * from player tracks and the court alone, so they survive the ball detector
 * being removed, and they are the things a coach actually says out loud --
 * "get to the kitchen", "you're stuck in no-man's land", "you left the middle
 * open" -- rather than statistics about a sport.
 *
 * EVERYTHING IS IN FEET FROM THE NET, not in normalised court units, because
 * the normalised units are not comparable between clips: a "full" quad puts
 * the net at y=0.5, a "near-half" quad at y=0, and a "near-inplay" quad at
 * y=-7/15, with a different number of feet per unit in each. Converting once,
 * here, means every threshold below is a real distance a person can picture.
 */
import type { CourtFrame } from "./shots";

/** A pickleball court is 20 ft wide and 22 ft from net to baseline. */
const HALF_LENGTH_FT = 22;
const WIDTH_FT = 20;

/** The non-volley line is 7 ft from the net. */
export const KITCHEN_LINE_FT = 7;
/**
 * A player standing within 2 ft behind the line is "at the kitchen".
 *
 * Not zero tolerance: nobody stands with their toes on the paint for a whole
 * point, and the coaching question is "are they up at the line or not", which
 * a couple of feet does not change.
 */
export const AT_KITCHEN_FT = KITCHEN_LINE_FT + 2;
/** Past this, they are at the back of the court rather than in transition. */
export const BACK_COURT_FT = 20;

export type CourtSide = "near" | "far";
export type CourtZone = "kitchen" | "transition" | "back";

export interface PositionSample {
  timestampSeconds: number;
  /** Normalised court coordinates, as stored. */
  courtX: number;
  courtY: number;
}

export interface PlayerPositions {
  playerId: string;
  samples: PositionSample[];
}

/** Feet from the net. Always positive; the side is a separate question. */
export function feetFromNet(courtY: number, frame: CourtFrame): number {
  const feetPerUnit = HALF_LENGTH_FT / Math.abs(frame.halfLength);
  return Math.abs(courtY - frame.netY) * feetPerUnit;
}

export function sideOfCourt(courtY: number, frame: CourtFrame): CourtSide {
  // Court y grows toward the camera in every frame kind, so a player with a
  // larger y than the net is on the near side.
  return courtY > frame.netY ? "near" : "far";
}

export function zoneAt(courtY: number, frame: CourtFrame): CourtZone {
  const ft = feetFromNet(courtY, frame);
  if (ft <= AT_KITCHEN_FT) return "kitchen";
  if (ft <= BACK_COURT_FT) return "transition";
  return "back";
}

export interface ZoneBreakdown {
  /** Fraction of tracked time in each zone. Sums to 1 when any samples exist. */
  kitchen: number;
  transition: number;
  back: number;
  samples: number;
}

/**
 * How a player splits their time between the three zones.
 *
 * `kitchen` is the number worth showing on its own: it is the most
 * level-diagnostic single statistic in the sport. Recreational players hang
 * back; strong players live at the line.
 *
 * Unweighted by time between samples, deliberately -- the tracker samples at a
 * fixed rate, so every sample already represents the same slice of clock, and
 * weighting by gaps would let one long tracking dropout dominate the answer.
 */
export function zoneBreakdown(samples: PositionSample[], frame: CourtFrame): ZoneBreakdown {
  const counts = { kitchen: 0, transition: 0, back: 0 };
  for (const s of samples) counts[zoneAt(s.courtY, frame)]++;
  const n = samples.length;
  if (n === 0) return { kitchen: 0, transition: 0, back: 0, samples: 0 };
  return {
    kitchen: counts.kitchen / n,
    transition: counts.transition / n,
    back: counts.back / n,
    samples: n,
  };
}

export interface ApproachResult {
  /** One entry per event the player actually closed the distance after. */
  secondsToKitchen: number[];
  /** Events where they never reached the kitchen before the window ran out. */
  neverArrived: number;
  medianSeconds: number | null;
}

/**
 * How long it takes to get to the kitchen after a given moment.
 *
 * The moment is passed in rather than detected here, because the shot that
 * matters -- the return of serve -- is Gemini's to identify now. That also
 * keeps this usable for any other trigger later without touching it.
 *
 * A player already at the kitchen when the event fires is not counted at all,
 * rather than counted as zero: the question is how fast they close, and
 * someone who never had to close has not answered it. Counting them as 0.0s
 * would drag the median toward "instant" exactly for the players who never
 * make the move.
 */
export function timeToKitchenAfter(
  samples: PositionSample[],
  eventTimes: number[],
  frame: CourtFrame,
  windowSeconds = 8
): ApproachResult {
  const sorted = [...samples].sort((a, b) => a.timestampSeconds - b.timestampSeconds);
  const secondsToKitchen: number[] = [];
  let neverArrived = 0;

  for (const t of eventTimes) {
    const at = sorted.find((s) => s.timestampSeconds >= t);
    if (!at) continue;
    if (zoneAt(at.courtY, frame) === "kitchen") continue; // already there

    const arrival = sorted.find(
      (s) => s.timestampSeconds > t
        && s.timestampSeconds <= t + windowSeconds
        && zoneAt(s.courtY, frame) === "kitchen"
    );
    if (arrival) secondsToKitchen.push(Math.round((arrival.timestampSeconds - t) * 100) / 100);
    else neverArrived++;
  }

  const s = [...secondsToKitchen].sort((a, b) => a - b);
  const medianSeconds = s.length === 0
    ? null
    : s.length % 2 === 1
      ? s[(s.length - 1) / 2]
      : Math.round(((s[s.length / 2 - 1] + s[s.length / 2]) / 2) * 100) / 100;

  return { secondsToKitchen, neverArrived, medianSeconds };
}

export interface PartnerGapResult {
  meanFeet: number | null;
  maxFeet: number | null;
  /** Fraction of shared samples where the gap exceeded `wideFeet`. */
  fractionWide: number;
  samples: number;
}

/**
 * How far apart two partners are, in feet, over the clip.
 *
 * WHY THIS MATTERS more than it sounds: most doubles points are lost through
 * the middle or into a gap, and partners are supposed to move as a connected
 * pair -- when one goes wide the other slides across. A gap that opens past
 * roughly half the court's width is a hole the opponent can see.
 *
 * Samples are matched by nearest timestamp within `toleranceSeconds` rather
 * than by index, because the two tracks are not guaranteed to have a sample at
 * the same instants -- one player can be missed for a frame. Pairing by index
 * would silently compare different moments and report a gap neither player
 * ever had.
 */
export function partnerGap(
  a: PositionSample[],
  b: PositionSample[],
  frame: CourtFrame,
  opts: { wideFeet?: number; toleranceSeconds?: number } = {}
): PartnerGapResult {
  const wideFeet = opts.wideFeet ?? 12;
  const tol = opts.toleranceSeconds ?? 0.15;
  const feetPerUnitY = HALF_LENGTH_FT / Math.abs(frame.halfLength);

  const bSorted = [...b].sort((x, y) => x.timestampSeconds - y.timestampSeconds);
  const gaps: number[] = [];
  for (const s of a) {
    let best: PositionSample | null = null;
    let bestDt = tol;
    for (const o of bSorted) {
      const dt = Math.abs(o.timestampSeconds - s.timestampSeconds);
      if (dt <= bestDt) { bestDt = dt; best = o; }
    }
    if (!best) continue;
    const dx = (s.courtX - best.courtX) * WIDTH_FT;
    const dy = (s.courtY - best.courtY) * feetPerUnitY;
    gaps.push(Math.hypot(dx, dy));
  }

  if (gaps.length === 0) {
    return { meanFeet: null, maxFeet: null, fractionWide: 0, samples: 0 };
  }
  const mean = gaps.reduce((x, y) => x + y, 0) / gaps.length;
  return {
    meanFeet: Math.round(mean * 10) / 10,
    maxFeet: Math.round(Math.max(...gaps) * 10) / 10,
    fractionWide: gaps.filter((g) => g > wideFeet).length / gaps.length,
    samples: gaps.length,
  };
}

/** The two players on the same side as `playerId`, for partner pairing. */
export function partnerOf(
  playerId: string,
  players: PlayerPositions[],
  frame: CourtFrame
): PlayerPositions | null {
  const me = players.find((p) => p.playerId === playerId);
  if (!me || me.samples.length === 0) return null;
  const mySide = majoritySide(me.samples, frame);
  const sameSide = players.filter(
    (p) => p.playerId !== playerId
      && p.samples.length > 0
      && majoritySide(p.samples, frame) === mySide
  );
  // Exactly one partner, or we do not know which it is. Two candidates on one
  // side means the tracker found a spectator or split a track, and guessing
  // would attribute someone else's position to the player's own game.
  return sameSide.length === 1 ? sameSide[0] : null;
}

/** Which side a player spent most of their time on — robust to a stray sample. */
export function majoritySide(samples: PositionSample[], frame: CourtFrame): CourtSide {
  let near = 0;
  for (const s of samples) if (sideOfCourt(s.courtY, frame) === "near") near++;
  return near * 2 >= samples.length ? "near" : "far";
}

/**
 * One player's positioning summary for a clip — the persisted shape.
 *
 * Everything here is either a fraction, a count, or feet/seconds, and nothing
 * is in raw court units: this is the record a UI renders and a coach reads,
 * and court units are meaningless outside the homography that produced them.
 *
 * The three approach fields are filled in AFTER the vision run, by the
 * coaching layer: the trigger for "time to the kitchen" is the return of
 * serve, which only the model watching the video can identify. They are part
 * of this shape rather than a separate one because they are the same
 * question — where was this player, and when — and splitting them across two
 * records would mean joining them back together at every read.
 */
export interface PlayerPositioning {
  playerId: string;
  side: CourtSide;
  zones: { kitchen: number; transition: number; back: number };
  samples: number;
  /** Seconds spent at the kitchen line, from the fraction and the tracked span. */
  kitchenSeconds: number;
  trackedSeconds: number;
  partnerId: string | null;
  partnerGapMeanFeet: number | null;
  partnerGapMaxFeet: number | null;
  /** Fraction of shared samples wider than the "hole in the middle" threshold. */
  partnerGapFractionWide: number | null;
  /** Median seconds to reach the kitchen after a return. Null until measured. */
  secondsToKitchenMedian: number | null;
  approachesMeasured: number;
  approachesNeverArrived: number;
}
