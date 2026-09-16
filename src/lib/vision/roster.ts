/**
 * Exactly four players, the same four, for the whole clip.
 *
 * WHAT THIS REPLACES, AND WHY. The tracker builds identities over TIME: it
 * matches each detection to whichever existing track it overlaps, and starts a
 * NEW track when nothing matches well enough. That is the standard approach
 * and it has one structural flaw -- the number of identities is an output, not
 * an input. Every occlusion, every walk out of frame, every missed frame is a
 * chance to mint another one. A real clip produced SEVENTY-THREE tracks for
 * four players and two people watching from behind the fence, and the tag page
 * asked the user to pick their own out of seventy-three chips.
 *
 * Nothing downstream could fix that, because by then the information was gone.
 * A merge pass can group fragments, and one does, but it is guessing at an
 * answer the sport already knows.
 *
 * SO THE COUNT IS AN INPUT HERE. Doubles is two players each side of the net.
 * That is not a heuristic, it is the rules, and it holds in every frame of
 * every clip. This module takes that as given and asks a different question of
 * each frame -- not "is this a new person?" but "which of our four is this?".
 * There are no track ids to fragment, so seventy-three is not a number this
 * can produce. The answer is always four.
 *
 * THREE THINGS IT DOES, IN ORDER:
 *
 *   1. DROPS ANYONE NOT ON THE COURT. The court is known in feet, so a body
 *      whose feet land outside the lines is not in this game -- the pair
 *      waiting for the next court, somebody walking past with a paddle bag,
 *      the spectators along the fence. They were a large share of those
 *      seventy-three.
 *
 *   2. SPLITS BY SIDE OF THE NET. Nobody crosses the net during a point. A
 *      detection on the far side can never be the near-side player, whatever
 *      it looks like and however close the boxes happen to be in the image --
 *      two players at the net are a few pixels apart on screen and twenty feet
 *      apart on the court, which is exactly the case that swaps identities.
 *
 *   3. ASSIGNS EACH FRAME TO FIXED SLOTS. Two slots per side, matched on court
 *      distance first and appearance second. Appearance is the tiebreaker
 *      rather than the signal, because partners in similar kit are the normal
 *      case and geometry is not fooled by a shirt colour.
 */

import type {
  AppearanceSignature, BoundingBoxNorm, FrameDetectionSet,
  PlayerTrack, PlayerTrackPoint,
} from "./phase2-types";

/** Court dimensions in feet. The net runs across the middle. */
export const COURT_W_FT = 20;
export const COURT_L_FT = 44;
export const NET_Y_FT = 22;

/**
 * How far outside the lines still counts as being in this game.
 *
 * SIX FEET, and it is deliberately generous. A player chasing a lob genuinely
 * stands well behind the baseline, and a homography fitted to slightly-off
 * corners puts everybody a foot or two out. The cost of being too tight is
 * dropping a real player mid-rally, which is invisible and ruins the read; the
 * cost of being too loose is that somebody standing just off the sideline
 * survives to be rejected later by the slot assignment anyway.
 */
export const ON_COURT_MARGIN_FT = 6;

/**
 * How far a player can be from where a slot expected them and still be them.
 *
 * Sixteen feet, which is most of the width of a court. That sounds enormous
 * and is the right order: at 5fps a sprinting player covers eight feet between
 * samples, and after a gap of several frames the prediction is stale. The
 * constraint doing the real work is the side of the net, not this.
 */
export const MAX_SLOT_JUMP_FT = 16;

/** Court position in feet, plus which side of the net it is on. */
export interface CourtPoint { x: number; y: number }
export type Side = "near" | "far";

export interface RosterOptions {
  /**
   * A detection's FEET in court feet, or null when the court is unknown.
   *
   * Feet rather than box centre: a court position is where someone is
   * standing, and the centre of a box rises and falls as a player crouches
   * and jumps, which reads as movement they did not make.
   */
  toCourtFeet: (box: BoundingBoxNorm) => CourtPoint | null;
  /** 2 for doubles, 1 for singles. */
  slotsPerSide?: number;
  marginFeet?: number;
}

export interface RosterResult {
  tracks: PlayerTrack[];
  /** What was thrown away and why, for the log line that explains the count. */
  detectionsSeen: number;
  droppedOffCourt: number;
  droppedNoCourt: number;
  droppedSurplus: number;
}

interface Slot {
  playerId: string;
  side: Side;
  points: PlayerTrackPoint[];
  last: CourtPoint | null;
  lastT: number | null;
  velocity: CourtPoint | null;
  appearance: AppearanceSignature | null;
}

interface Cand {
  box: BoundingBoxNorm;
  confidence: number;
  court: CourtPoint;
  appearance: AppearanceSignature | null;
}

/**
 * Four tracks (or two, in singles), one per player, for the whole clip.
 *
 * Returns an EMPTY track list when the court is unknown for most detections.
 * Everything here is built on court geometry, and without it this would be a
 * worse version of the tracker rather than a better one -- so it says it
 * cannot help and the caller falls back.
 */
export function buildRoster(perFrame: FrameDetectionSet[], opts: RosterOptions): RosterResult {
  const slotsPerSide = Math.max(1, Math.round(opts.slotsPerSide ?? 2));
  const margin = opts.marginFeet ?? ON_COURT_MARGIN_FT;

  const frames = [...perFrame].sort((a, b) => a.timestampSeconds - b.timestampSeconds);
  let detectionsSeen = 0;
  let droppedOffCourt = 0;
  let droppedNoCourt = 0;
  let droppedSurplus = 0;

  // ---- 1 & 2: on the court, and which side of the net -------------------
  const byFrame: Array<{ t: number; near: Cand[]; far: Cand[] }> = [];
  for (const f of frames) {
    const near: Cand[] = [];
    const far: Cand[] = [];
    for (const d of f.players) {
      detectionsSeen += 1;
      const court = opts.toCourtFeet(d.boxImageNorm);
      if (!court || !Number.isFinite(court.x) || !Number.isFinite(court.y)) {
        droppedNoCourt += 1;
        continue;
      }
      if (court.x < -margin || court.x > COURT_W_FT + margin
          || court.y < -margin || court.y > COURT_L_FT + margin) {
        droppedOffCourt += 1;
        continue;
      }
      const cand: Cand = {
        box: d.boxImageNorm,
        confidence: d.confidence ?? 0,
        court,
        appearance: d.appearanceSignature ?? null,
      };
      (court.y < NET_Y_FT ? near : far).push(cand);
    }
    byFrame.push({ t: f.timestampSeconds, near, far });
  }

  // Court geometry is the whole basis of this. Without it, say so.
  const placed = detectionsSeen - droppedNoCourt;
  if (detectionsSeen === 0 || placed < detectionsSeen * 0.5) {
    return { tracks: [], detectionsSeen, droppedOffCourt, droppedNoCourt, droppedSurplus };
  }

  // ---- 3: fixed slots, assigned per frame -------------------------------
  const slots: Slot[] = [];
  let n = 1;
  for (const side of ["near", "far"] as const) {
    for (let i = 0; i < slotsPerSide; i++) {
      slots.push({
        playerId: `player_${n++}`, side,
        points: [], last: null, lastT: null, velocity: null, appearance: null,
      });
    }
  }

  for (const frame of byFrame) {
    for (const side of ["near", "far"] as const) {
      const mine = slots.filter((s) => s.side === side);
      const cands = [...(side === "near" ? frame.near : frame.far)]
        // Most confident first, so when there are more bodies than slots the
        // ones dropped are the marginal detections rather than arbitrary ones.
        .sort((a, b) => b.confidence - a.confidence);
      if (cands.length === 0) continue;

      // Seed: the first frame with people on this side sets the slots, in
      // court order left to right so the numbering is stable and meaningful
      // rather than whatever order the detector happened to emit.
      const unseeded = mine.filter((s) => s.last === null);
      if (unseeded.length === mine.length) {
        const seeds = [...cands].slice(0, mine.length).sort((a, b) => a.court.x - b.court.x);
        seeds.forEach((c, i) => place(mine[i], c, frame.t));
        droppedSurplus += Math.max(0, cands.length - mine.length);
        continue;
      }

      const taken = assign(mine, cands, frame.t);
      for (const [slotIdx, candIdx] of taken) place(mine[slotIdx], cands[candIdx], frame.t);
      droppedSurplus += Math.max(0, cands.length - taken.length);
    }
  }

  const tracks: PlayerTrack[] = slots
    .filter((s) => s.points.length > 0)
    .map((s) => ({ playerId: s.playerId, points: s.points }));

  return { tracks, detectionsSeen, droppedOffCourt, droppedNoCourt, droppedSurplus };
}

function place(slot: Slot, c: Cand, t: number): void {
  if (slot.last !== null && slot.lastT !== null && t > slot.lastT) {
    const dt = t - slot.lastT;
    slot.velocity = { x: (c.court.x - slot.last.x) / dt, y: (c.court.y - slot.last.y) / dt };
  }
  slot.last = c.court;
  slot.lastT = t;
  if (c.appearance) {
    // A slow average, so one frame where a player is half behind their partner
    // does not rewrite what they look like.
    slot.appearance = slot.appearance
      ? blend(slot.appearance, c.appearance, 0.2)
      : c.appearance;
  }
  slot.points.push({
    timestampSeconds: t,
    boxImageNorm: c.box,
    confidence: c.confidence,
    courtPosition: { x: c.court.x, y: c.court.y },
  });
}

/**
 * The best pairing of slots to detections on one side of the net.
 *
 * Brute force over permutations, which is fine and will stay fine: there are
 * at most two slots a side, so at most two orderings to compare. A greedy
 * nearest-first pass would be cheaper and wrong in the case that matters --
 * two players converging at the kitchen, where the greedy choice takes the
 * globally worse pairing and swaps their identities for the rest of the point.
 */
function assign(slots: Slot[], cands: Cand[], t: number): Array<[number, number]> {
  const k = Math.min(slots.length, cands.length);
  if (k === 0) return [];

  // WHICH SLOTS, not just which candidates. The first version of this looped
  // `for (let si = 0; si < k; si++)`, which means that with one player visible
  // on a side -- the normal case the moment anybody is occluded -- the single
  // detection was always handed to slot 0, whoever it actually was. The near
  // pair swapped identities every time one of them was briefly lost.
  let best: { pairs: Array<[number, number]>; cost: number } | null = null;
  for (const slotCombo of choose(slots.length, k)) {
    for (const candCombo of choose(cands.length, k)) {
      for (const perm of permutations(candCombo)) {
        let cost = 0;
        const pairs: Array<[number, number]> = [];
        let ok = true;
        for (let i = 0; i < k; i++) {
          const c = cost1(slots[slotCombo[i]], cands[perm[i]], t);
          if (c === null) { ok = false; break; }
          cost += c;
          pairs.push([slotCombo[i], perm[i]]);
        }
        if (ok && (!best || cost < best.cost)) best = { pairs, cost };
      }
    }
  }
  return best ? best.pairs : [];
}

/**
 * What it costs to call this detection this slot, or null for impossible.
 *
 * THE PREDICTION IS THE POINT, and the first version of this file threw it
 * away -- it computed a velocity and then multiplied it by zero, so every
 * comparison was against where the player WAS rather than where they were
 * going. That is invisible in ordinary play and decides exactly one case: two
 * players crossing. At the moment they meet, both are equidistant from both
 * slots and the pairing is a coin toss; a step of extrapolation carries each
 * slot THROUGH the other, so the cheaper pairing is the one where both
 * players keep going, which is what they actually did.
 *
 * Capped at a second of extrapolation: past that a stale velocity is a worse
 * guess than the last known position.
 */
const MAX_PREDICT_S = 1.0;

/**
 * How far extrapolation is allowed to move a slot, in feet.
 *
 * DEFENSIVE, NOT LOAD-BEARING, and the distinction is worth recording because
 * the first version of this comment claimed otherwise. A 1,500-frame
 * simulation of four jittering players with 25% dropout left the slots holding
 * 2, 1, 18 and 9 points, and the cause looked like runaway extrapolation: a
 * jittery velocity predicts a player somewhere they never were, nothing
 * matches, the slot is not updated, the gap grows, the prediction worsens.
 * Plausible, and wrong. Reverting this clamp and the feasibility rule below
 * changes that simulation by nothing at all; reverting the slot-subset fix in
 * assign() reproduces the whole failure. That bug was the cause.
 *
 * Kept anyway: a velocity measured over one 0.2s sample extrapolated across a
 * multi-second gap is not evidence, and eight feet is about as far as a
 * pickleball player travels in the time this is willing to predict over.
 */
const MAX_PREDICT_FT = 8;

function cost1(slot: Slot, c: Cand, t: number): number | null {
  if (slot.last === null) return 50; // an unseeded slot takes anything, at a price
  const dt = slot.lastT === null ? 0 : Math.min(MAX_PREDICT_S, Math.max(0, t - slot.lastT));
  let predicted = slot.last;
  if (slot.velocity) {
    const dx = slot.velocity.x * dt, dy = slot.velocity.y * dt;
    const mag = Math.hypot(dx, dy);
    const k = mag > MAX_PREDICT_FT ? MAX_PREDICT_FT / mag : 1;
    predicted = { x: slot.last.x + dx * k, y: slot.last.y + dy * k };
  }
  const d = Math.hypot(c.court.x - predicted.x, c.court.y - predicted.y);
  // FEASIBILITY IS JUDGED AGAINST THE LAST KNOWN POSITION, ranking against the
  // prediction. A prediction is a guess and must never be able to rule a real
  // detection out; where the player actually was is a fact.
  const fromLast = Math.hypot(c.court.x - slot.last.x, c.court.y - slot.last.y);
  if (Math.min(d, fromLast) > MAX_SLOT_JUMP_FT) return null;
  // Appearance is worth a couple of feet, no more. It breaks ties between two
  // players standing close together; it never overrules where they are.
  const look = slot.appearance && c.appearance
    ? appearanceDistance(slot.appearance, c.appearance) * 3
    : 0;
  return d + look;
}

/** 0 (identical) to 1 (opposite), on hue with saturation and value as support. */
export function appearanceDistance(a: AppearanceSignature, b: AppearanceSignature): number {
  let dh = Math.abs(a.h - b.h) % 360;
  if (dh > 180) dh = 360 - dh;
  // Hue is meaningless on a grey or black shirt, so it counts for less the
  // less saturated the two are -- otherwise two players in black are compared
  // on the noise in their hue readings.
  const sat = Math.min(a.s, b.s);
  return (dh / 180) * sat + Math.abs(a.s - b.s) * 0.3 + Math.abs(a.v - b.v) * 0.3;
}

function blend(a: AppearanceSignature, b: AppearanceSignature, w: number): AppearanceSignature {
  // Hue is circular: averaging 350 and 10 the naive way gives 180, the exact
  // opposite colour.
  const rad = (d: number) => (d * Math.PI) / 180;
  const x = Math.cos(rad(a.h)) * (1 - w) + Math.cos(rad(b.h)) * w;
  const y = Math.sin(rad(a.h)) * (1 - w) + Math.sin(rad(b.h)) * w;
  const h = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return { h, s: a.s * (1 - w) + b.s * w, v: a.v * (1 - w) + b.v * w };
}

/** Index combinations of size k from n, k <= n, small by construction. */
function choose(n: number, k: number): number[][] {
  const out: number[][] = [];
  const walk = (start: number, acc: number[]) => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i < n; i++) { acc.push(i); walk(i + 1, acc); acc.pop(); }
  };
  walk(0, []);
  return out;
}

function permutations(xs: number[]): number[][] {
  if (xs.length <= 1) return [xs];
  const out: number[][] = [];
  for (let i = 0; i < xs.length; i++) {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
    for (const p of permutations(rest)) out.push([xs[i], ...p]);
  }
  return out;
}
