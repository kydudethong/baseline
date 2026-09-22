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
 * IT USED TO NEED A COURT, AND THAT WAS A BUG WAITING FOR ITS CAUSE.
 *
 * The first version measured everything in court feet and returned NOTHING
 * when the homography was unavailable, on the reasoning that without geometry
 * it would be a worse tracker rather than a better one. Then court detection
 * was removed from the product and corner-marking with it, so the homography
 * became unavailable on EVERY run: `toCourtFeet` returned null for every box,
 * the bail-out fired every time, and the caller fell back to the very tracker
 * this module exists to replace. Seventy-four chips came back. The roster was
 * shipped, deployed, and dead on arrival, and the log line that said so --
 * "no court geometry, fell back to tracking" -- was the only evidence.
 *
 * The lesson is not "keep the court". It is that the court was never the load-
 * bearing part. What the roster actually needs is three things:
 *
 *   - somewhere to put a player, so two frames can be compared,
 *   - a length to divide by, so "far" means the same near and far,
 *   - a line nobody crosses, so identities cannot swap across it.
 *
 * A court supplies all three exactly (feet, the foot, the net). An IMAGE
 * supplies all three approximately, and approximately is enough for an
 * assignment problem with two candidates per side. So the geometry lives
 * behind a Plane now, with two implementations:
 *
 *   COURT PLANE  units are feet; the net is y = 22; off-court bodies are
 *                dropped by the lines themselves. Unchanged, and still the
 *                better one when a homography exists.
 *
 *   IMAGE PLANE  units are the player's own box height, so a stride at the far
 *                baseline costs the same as a stride at the near one despite
 *                being a third the pixels. The dividing line is LEARNED from
 *                the clip (see splitAxis), because a camera behind a baseline
 *                separates the sides in image y and a camera at the side
 *                separates them in x, and which one is true is a fact about
 *                the footage that can be measured rather than assumed.
 *
 * Neither returns empty. Four slots in, at most four tracks out, always.
 *
 * THREE THINGS IT DOES, IN ORDER:
 *
 *   1. DROPS ANYONE NOT ON THE COURT, when the court is known. A body whose
 *      feet land outside the lines is not in this game -- the pair waiting for
 *      the next court, somebody walking past with a paddle bag, the spectators
 *      along the fence. They were a large share of those seventy-three. On the
 *      image plane there are no lines to test against, so this step does
 *      nothing and step 3 does the work instead: a spectator has to out-bid a
 *      real player for a slot, every frame, on motion and appearance both.
 *
 *   2. SPLITS BY SIDE OF THE NET. Nobody crosses the net during a point. A
 *      detection on the far side can never be the near-side player, whatever
 *      it looks like and however close the boxes happen to be in the image --
 *      two players at the net are a few pixels apart on screen and twenty feet
 *      apart on the court, which is exactly the case that swaps identities.
 *
 *   3. ASSIGNS EACH FRAME TO FIXED SLOTS. Two slots per side, matched on
 *      distance first and appearance second. Appearance is the tiebreaker
 *      rather than the signal, because partners in similar kit are the normal
 *      case and geometry is not fooled by a shirt colour.
 */

import { blendBuild, buildDistance, type BuildSignature } from "./build-signature";
import type {
  AppearanceSignature, BoundingBoxNorm, ColourBand, FrameDetectionSet,
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
 * How far outside the lines a SEED may be.
 *
 * THE COMMENT ABOVE PROMISED A SAFETY NET THAT DID NOT EXIST. It says the cost
 * of a loose margin is that "somebody standing just off the sideline survives
 * to be rejected later by the slot assignment anyway" -- and the assignment
 * did no such thing. It seeded on the first frame containing anybody, taking
 * the most confident detections, so a bystander near the camera (large, sharp,
 * very confident) beat a real player at the far baseline (small, blurry) and
 * then held that slot for the whole clip.
 *
 * Reported from real footage: two of the four tagged players were off the
 * court and not the two who were playing.
 *
 * So seeding uses a foot and a half instead of six. That is the width of
 * homography error from slightly-off corners, not standing room: a player
 * whose court was marked a little wrong is inside it, and somebody waiting
 * beside the sideline for the next game is not.
 */
export const SEED_MARGIN_FT = 1.5;

/**
 * How far a player can be from where a slot expected them and still be them.
 *
 * Sixteen feet, which is most of the width of a court. That sounds enormous
 * and is the right order: at 5fps a sprinting player covers eight feet between
 * samples, and after a gap of several frames the prediction is stale. The
 * constraint doing the real work is the side of the net, not this.
 */
export const MAX_SLOT_JUMP_FT = 16;

/**
 * The same two limits on the image plane, in the player's own body heights.
 *
 * A pickleball player is about six feet of box, so sixteen feet is a touch
 * under three bodies and the numbers below are the court ones restated in the
 * unit the image can actually measure. They are not a second opinion; they are
 * the same generosity expressed in the only ruler available when there is no
 * homography.
 */
export const MAX_SLOT_JUMP_BODIES = 2.7;
const MAX_PREDICT_BODIES = 1.4;

/**
 * How deep the valley between the two sides has to be before it is believed.
 *
 * THREE FIFTHS: the dip between the two humps must be at least 60% lower than
 * the smaller hump is high. See otsuSplit for what the number measures.
 *
 * Chosen by measuring the two cases it has to separate rather than by taste.
 * With the adaptive binning in otsuSplit, a uniformly scattered set of points
 * -- no sides at all -- scores 0.20 to 0.27 across sample sizes from 240 to
 * 4000, which is the noise floor; two clearly separated groups score 1.00; and
 * the awkward middle cases (players roaming a shared band, four overlapping
 * paths) score 0.44 to 0.52. Three fifths sits above every one of those and
 * well below a real separation.
 *
 * It errs toward NOT splitting, deliberately. A line that is not there swaps
 * identities between players on opposite sides of the court, which is a wrong
 * answer; no line means one pool of four slots, which is a weaker answer. Four
 * either way -- the count, which is what a user has to act on, never moves.
 *
 * THIS REPLACES A THRESHOLD THAT DID NOTHING. The first version scored the
 * split with Otsu's own between-class variance ratio and demanded 0.35, on the
 * reasoning that 1 is two points and 0 is a smear. The second half of that is
 * false, and a test found it: a perfectly UNIFORM spread -- four players
 * scattered evenly with no sides at all -- scores 0.75 on that ratio, because
 * cutting any distribution at its middle separates its own two halves. The
 * measure never goes below about 0.75 for real data, so a floor of 0.35
 * accepted every clip and the "no usable net line" branch was unreachable. A
 * check that cannot fail is not a check.
 */
export const MIN_SPLIT_QUALITY = 0.6;

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
   *
   * Returning null for everything is now a supported answer, not a failure --
   * it selects the image plane instead.
   */
  toCourtFeet: (box: BoundingBoxNorm) => CourtPoint | null;
  /** 2 for doubles, 1 for singles. */
  slotsPerSide?: number;
  marginFeet?: number;
  /**
   * Frame width / height, so that a foot of sideways movement and a foot of
   * movement up the screen cost the same on the image plane. Without it a 16:9
   * frame makes horizontal movement look 1.78x cheaper than vertical, and the
   * slot that should follow a player running the width of the court instead
   * hands them to their partner.
   */
  imageAspect?: number;
  /**
   * The people the user TAPPED on the setup frame: who they are, when, and
   * the box around them there (normalised).
   *
   * WHAT THIS FIXES. A slot's idea of what its player looks like is a running
   * average that follows whoever the slot is on. So one bad hand-off --
   * teammates crossing, a player hidden for a moment, somebody by the fence --
   * and the slot's own model becomes the wrong person, after which it happily
   * keeps them. Reported three ways from real use: the analysed player's box
   * went to a bystander, to an opponent and to the teammate.
   *
   * An anchor is a FIXED picture of the tapped person, taken around the moment
   * they were tapped, that never updates. The slot it is given to pays for
   * every frame it sits on somebody who does not look like that person, so a
   * hand-off to the wrong body costs more the longer it lasts, and the slot
   * snaps back as soon as the real player is detectable again.
   */
  anchors?: RosterAnchor[];
}

export interface RosterAnchor {
  role: "self" | "partner";
  timestampSeconds: number;
  box: BoundingBoxNorm;
}

export interface RosterResult {
  tracks: PlayerTrack[];
  /** Which geometry was available, for the log line that explains the count. */
  plane: "court" | "image";
  /** How the two sides were told apart on the image plane. */
  split: { axis: "x" | "y"; at: number; quality: number } | null;
  detectionsSeen: number;
  droppedOffCourt: number;
  droppedNoCourt: number;
  droppedSurplus: number;
  /** The slot carrying each anchor, when the anchor was found in the detections. */
  roles: { self: string | null; partner: string | null };
}

/**
 * Somewhere to stand, a length to divide by, and a line nobody crosses.
 *
 * Everything the roster needs from geometry, and the only thing that differs
 * between having a court and not having one.
 */
interface Plane {
  kind: "court" | "image";
  /** Where this detection is, in plane units, or null if it cannot be placed. */
  pos(box: BoundingBoxNorm): CourtPoint | null;
  /** One body length in plane units. Distances are divided by this. */
  unit(box: BoundingBoxNorm): number;
  /** False for a body that is not in this game at all. */
  inPlay(p: CourtPoint): boolean;
  /**
   * Inside the painted lines, near enough that this is somebody PLAYING.
   *
   * Stricter than inPlay on purpose. inPlay is deliberately loose -- six feet
   * outside the lines -- because a player chasing a lob really does stand well
   * behind the baseline and losing them mid-rally is invisible and ruinous.
   * Seeding is the opposite problem: the four bodies that claim the slots
   * should be the four on the court, not whoever the detector saw first.
   */
  onCourtStrict(p: CourtPoint): boolean;
  /** Which group this position belongs to, or null when there is no line. */
  side(p: CourtPoint): Side | null;
  /** Both in body units, so they mean the same thing on either plane. */
  maxJump: number;
  maxPredict: number;
}

interface Slot {
  playerId: string;
  group: string;
  points: PlayerTrackPoint[];
  last: CourtPoint | null;
  lastT: number | null;
  /** Plane units per second. */
  velocity: CourtPoint | null;
  /** A smoothed body length, so the cost scale survives a bad frame. */
  unit: number | null;
  appearance: AppearanceSignature | null;
  build: BuildSignature | null;
  /** How many build readings have gone into it, since one is not a shape. */
  buildSamples: number;
  /** A fixed picture of the person this slot must be. See RosterOptions.anchors. */
  anchor: AnchorRef | null;
  /** What each point in `points` looked like, index for index. For relabelling. */
  looks: Array<AppearanceSignature | null>;
}

interface AnchorRef {
  role: "self" | "partner";
  group: string;
  appearance: AppearanceSignature | null;
  build: BuildSignature | null;
  buildSamples: number;
}

interface Cand {
  box: BoundingBoxNorm;
  confidence: number;
  pos: CourtPoint;
  unit: number;
  appearance: AppearanceSignature | null;
  build: BuildSignature | null;
}

/** The court plane: feet, the lines, and the net at y = 22. */
function courtPlane(
  toCourtFeet: (box: BoundingBoxNorm) => CourtPoint | null,
  margin: number,
): Plane {
  return {
    kind: "court",
    pos: (box) => {
      const c = toCourtFeet(box);
      return c && Number.isFinite(c.x) && Number.isFinite(c.y) ? c : null;
    },
    // One foot is one foot everywhere on a court, which is the entire point of
    // having one. The limits below are therefore already in these units.
    unit: () => 1,
    inPlay: (p) =>
      p.x >= -margin && p.x <= COURT_W_FT + margin
      && p.y >= -margin && p.y <= COURT_L_FT + margin,
    // A FOOT AND A HALF, which is homography error rather than standing room.
    // Somebody beside the sideline waiting for the next game is outside this;
    // a player whose corner-marking is slightly off is not.
    onCourtStrict: (p) =>
      p.x >= -SEED_MARGIN_FT && p.x <= COURT_W_FT + SEED_MARGIN_FT
      && p.y >= -SEED_MARGIN_FT && p.y <= COURT_L_FT + SEED_MARGIN_FT,
    side: (p) => (p.y < NET_Y_FT ? "near" : "far"),
    maxJump: MAX_SLOT_JUMP_FT,
    maxPredict: 8,
  };
}

/**
 * The image plane: body heights, no lines, and a dividing line read off the
 * clip's own histogram of where people stand.
 */
function imagePlane(
  aspect: number,
  split: { axis: "x" | "y"; at: number; quality: number } | null,
): Plane {
  return {
    kind: "image",
    // The feet, for the same reason the court plane uses them: the bottom edge
    // of a box is where the player is standing, while its centre rises and
    // falls as they crouch and jump.
    pos: (box) => ({ x: (box.x + box.width / 2) * aspect, y: box.y + box.height }),
    // BOX HEIGHT IS THE RULER. It is roughly proportional to 1/distance, which
    // is exactly the correction perspective needs: the far player's box is a
    // third the height and their strides cover a third the pixels, so dividing
    // by it makes the two halves of the court comparable without ever knowing
    // where the court is. Floored so a degenerate box cannot divide by zero
    // and make every distance infinite.
    unit: (box) => Math.max(0.02, box.height),
    // There are no lines to be outside of. A spectator gets in only by winning
    // a slot against a real player on motion and appearance, every frame.
    inPlay: () => true,
    // No lines to be inside of. Every candidate is equally plausible, which is
    // the honest answer without a court and the reason the court is required.
    onCourtStrict: () => true,
    side: (p) => {
      if (!split) return null;
      const v = split.axis === "y" ? p.y : p.x;
      // Smaller is "far": higher in the frame for a camera behind a baseline,
      // and an arbitrary but consistent naming for one at the side. Nothing
      // downstream reads meaning into which group is which -- only that a
      // detection in one can never be assigned to a slot in the other.
      return v < split.at ? "far" : "near";
    },
    maxJump: MAX_SLOT_JUMP_BODIES,
    maxPredict: MAX_PREDICT_BODIES,
  };
}

/**
 * Where the net is on one axis, and whether there is a net there at all.
 *
 * TWO DIFFERENT JOBS, and the mistake worth recording is that they were once
 * done by the same number. Otsu's method answers the first well: every
 * detection in the clip votes with its feet, and the threshold that best
 * separates the votes is the net. It answers the second not at all -- its
 * between-class variance ratio is 0.75 for a perfectly uniform spread, so
 * "there are two groups here" and "there is one smear here" score 0.75 and 1.0
 * and are not usefully distinguishable by any floor.
 *
 * So the threshold comes from Otsu and the CONFIDENCE comes from the shape of
 * the histogram around it: how deep the valley is, as a fraction of the
 * shorter of the two humps either side. Two separated groups leave the valley
 * empty and score near 1; a smear has no valley and scores near 0. That is the
 * question actually being asked -- does this footage show two groups of
 * players, or one -- rather than a proxy for it.
 */
export function otsuSplit(values: number[]): { at: number; quality: number } | null {
  if (values.length < 8) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!(max > min)) return null;

  const BINS = 64;
  const hist = new Array(BINS).fill(0) as number[];
  for (const v of values) {
    const b = Math.min(BINS - 1, Math.floor(((v - min) / (max - min)) * BINS));
    hist[b] += 1;
  }
  const n = values.length;
  const mean = values.reduce((a, v) => a + v, 0) / n;
  const total = values.reduce((a, v) => a + (v - mean) * (v - mean), 0) / n;
  if (!(total > 0)) return null;

  const binCentre = (b: number) => min + ((b + 0.5) / BINS) * (max - min);
  let wB = 0;
  let sumB = 0;
  const sumAll = hist.reduce((a, c, b) => a + c * binCentre(b), 0);
  let bestBetween = -1;
  const ties: number[] = [];
  for (let b = 0; b < BINS - 1; b++) {
    wB += hist[b];
    sumB += hist[b] * binCentre(b);
    const wF = n - wB;
    if (wB === 0 || wF === 0) continue;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = (wB / n) * (wF / n) * (mB - mF) * (mB - mF);
    if (between > bestBetween * (1 + 1e-9)) { bestBetween = between; ties.length = 0; ties.push(b); }
    else if (between >= bestBetween * (1 - 1e-9)) ties.push(b);
  }
  if (ties.length === 0) return null;
  // THE MIDDLE OF THE VALLEY, not its near edge. Every empty bin between two
  // groups scores identically, so the maximum is a plateau and taking the
  // first element of it puts the line hard against the left-hand group. That
  // is wrong twice over: the net belongs in the middle of the gap, and a
  // threshold pressed against one hump leaves no room to measure how deep the
  // gap is, which read as "no separation" on the cleanest possible input.
  const cutBin = ties[Math.floor((ties.length - 1) / 2)];
  const best = { at: min + ((cutBin + 1) / BINS) * (max - min) };

  // NEITHER SIDE MAY BE A SLIVER. Doubles puts roughly half the detections
  // each side; even a badly occluded far court keeps more than a seventh of
  // them. A "side" holding less than that is one player who wandered, or the
  // tail of a single group, and splitting there would strand three players in
  // two slots while one sat alone in the other two.
  const below = values.filter((v) => v < best.at).length;
  if (below < n * 0.15 || n - below < n * 0.15) return null;

  // HOW DEEP IS THE VALLEY. Smoothed over three bins first, because with a few
  // hundred samples across 64 bins a single empty bin is sampling noise and
  // would read as a chasm between two halves of one hump.
  // A COARSER HISTOGRAM FOR THE DENSITY, deliberately. The 64 bins above exist
  // to place the threshold precisely; asking them how DENSE the data is at a
  // point is asking a question they are too fine to answer, because a real
  // hump of a few hundred samples spread over 64 bins has empty bins in it by
  // chance and every one of them looks like a chasm. Two dozen bins is coarse
  // enough that a gap has to be real to show up, and needs no smoothing --
  // which is its own advantage, since a box filter smears a sharp group into
  // the bin beside it and fills in the very valley being measured.
  //
  // AND THE COUNT ADAPTS TO THE SAMPLE SIZE, because "coarse enough" is a
  // statement about samples per bin, not about bins. At roughly 25 per bin,
  // Poisson noise is about a fifth of a bin's height, so the shallowest real
  // valley still stands clear of it. A fixed 24 measured a genuinely uniform
  // scatter of 240 points at quality 0.67 -- noise alone, read as a net.
  const CBINS = Math.max(6, Math.min(24, Math.floor(n / 25)));
  const coarse = new Array(CBINS).fill(0) as number[];
  for (const v of values) {
    const b = Math.min(CBINS - 1, Math.floor(((v - min) / (max - min)) * CBINS));
    coarse[b] += 1;
  }
  const cut = Math.min(CBINS - 1, Math.max(0, Math.floor(((best.at - min) / (max - min)) * CBINS)));
  let peakL = 0, peakLBin = 0;
  for (let b = 0; b < cut; b++) if (coarse[b] > peakL) { peakL = coarse[b]; peakLBin = b; }
  let peakR = 0, peakRBin = CBINS - 1;
  for (let b = cut; b < CBINS; b++) if (coarse[b] > peakR) { peakR = coarse[b]; peakRBin = b; }
  // The SHORTER hump sets the scale, so a tall near-court hump cannot make a
  // shallow dip beside it look like a separation.
  const shorter = Math.min(peakL, peakR);
  if (shorter <= 0 || peakRBin - peakLBin < 2) return null;
  let valley = Infinity;
  for (let b = peakLBin + 1; b < peakRBin; b++) valley = Math.min(valley, coarse[b]);
  if (!Number.isFinite(valley)) return null;
  const quality = Math.max(0, Math.min(1, 1 - valley / shorter));
  return { at: best.at, quality };
}

/**
 * Four tracks (or two, in singles), one per player, for the whole clip.
 *
 * Never returns an empty list for want of geometry. When there is no court it
 * measures in body heights on the image plane instead, which is less accurate
 * and still bounded at four -- and four approximate players beat seventy-four
 * exact fragments, because the number is the thing the user has to act on.
 */
export function buildRoster(perFrame: FrameDetectionSet[], opts: RosterOptions): RosterResult {
  const slotsPerSide = Math.max(1, Math.round(opts.slotsPerSide ?? 2));
  const margin = opts.marginFeet ?? ON_COURT_MARGIN_FT;
  const aspect = opts.imageAspect && opts.imageAspect > 0 ? opts.imageAspect : 16 / 9;

  const frames = [...perFrame].sort((a, b) => a.timestampSeconds - b.timestampSeconds);
  let detectionsSeen = 0;
  let droppedOffCourt = 0;
  let droppedNoCourt = 0;
  let droppedSurplus = 0;

  // ---- which plane? ------------------------------------------------------
  //
  // A court is better when there is one, so ask first and settle for the image
  // only when the homography cannot place most of the detections. Half is the
  // threshold because a court that places some but not most of the bodies is a
  // court fitted to the wrong frame, and a wrong homography is worse than none.
  for (const f of frames) {
    for (const d of f.players) {
      detectionsSeen += 1;
      const c = opts.toCourtFeet(d.boxImageNorm);
      if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) droppedNoCourt += 1;
    }
  }
  const haveCourt = detectionsSeen > 0 && detectionsSeen - droppedNoCourt >= detectionsSeen * 0.5;

  let split: { axis: "x" | "y"; at: number; quality: number } | null = null;
  if (!haveCourt) {
    // Learn the dividing line before anything is assigned, from the whole clip
    // rather than one frame: a single frame during a dead ball can have all
    // four players standing at the net, where no line separates them.
    droppedNoCourt = 0;
    const probe = imagePlane(aspect, null);
    const xs: number[] = [];
    const ys: number[] = [];
    for (const f of frames) {
      for (const d of f.players) {
        const p = probe.pos(d.boxImageNorm)!;
        xs.push(p.x);
        ys.push(p.y);
      }
    }
    const byY = otsuSplit(ys);
    const byX = otsuSplit(xs);
    const bestAxis = (byY?.quality ?? -1) >= (byX?.quality ?? -1)
      ? (byY ? { axis: "y" as const, ...byY } : null)
      : (byX ? { axis: "x" as const, ...byX } : null);
    split = bestAxis && bestAxis.quality >= MIN_SPLIT_QUALITY ? bestAxis : null;
  }
  const plane = haveCourt ? courtPlane(opts.toCourtFeet, margin) : imagePlane(aspect, split);

  // ---- 1 & 2: in play, and which side of the line ------------------------
  //
  // GROUPS, not sides, because there may be only one. With a usable dividing
  // line the two groups are the two halves of the court and nobody crosses;
  // without one there is a single pool of 2 x slotsPerSide slots, which is
  // weaker (identities can swap between players who are nowhere near each
  // other) and still cannot produce a fifth person.
  const byFrame: Array<{ t: number; groups: Map<string, Cand[]> }> = [];
  for (const f of frames) {
    const groups = new Map<string, Cand[]>();
    for (const d of f.players) {
      const pos = plane.pos(d.boxImageNorm);
      if (!pos) { droppedNoCourt += 1; continue; }
      if (!plane.inPlay(pos)) { droppedOffCourt += 1; continue; }
      const cand: Cand = {
        box: d.boxImageNorm,
        confidence: d.confidence ?? 0,
        pos,
        unit: plane.unit(d.boxImageNorm),
        appearance: d.appearanceSignature ?? null,
        build: d.buildSignature ?? null,
      };
      const key = plane.side(pos) ?? "all";
      const list = groups.get(key);
      if (list) list.push(cand);
      else groups.set(key, [cand]);
    }
    byFrame.push({ t: f.timestampSeconds, groups });
  }

  // ---- 3: fixed slots, assigned per frame --------------------------------
  // A court always has two halves; the image plane has them only when the
  // split was believed. The key "all" is the pool every detection lands in
  // when there is no line, and matches what plane.side() returns as null.
  const hasSides = plane.kind === "court" || split !== null;
  const groupKeys: string[] = hasSides ? ["near", "far"] : ["all"];
  const perGroup = hasSides ? slotsPerSide : slotsPerSide * 2;
  const slots: Slot[] = [];
  let n = 1;
  for (const group of groupKeys) {
    for (let i = 0; i < perGroup; i++) {
      slots.push({
        playerId: `player_${n++}`, group,
        points: [], last: null, lastT: null, velocity: null, unit: null, appearance: null,
        build: null, buildSamples: 0, anchor: null, looks: [],
      });
    }
  }

  // ---- anchors: who the user tapped, fixed ---------------------------------
  const refs = (opts.anchors ?? [])
    .map((a) => anchorRef(a, byFrame, plane))
    .filter((x): x is AnchorRef => x !== null);
  const roles: { self: string | null; partner: string | null } = { self: null, partner: null };
  for (const role of ["self", "partner"] as const) {
    const ref = refs.find((x) => x.role === role);
    if (!ref) continue;
    // A group with no line is "all"; with one, the tap says which half.
    const group = hasSides ? ref.group : "all";
    const free = slots.find((sl) => sl.group === group && sl.anchor === null);
    if (!free) continue;
    free.anchor = { ...ref, group };
    roles[role] = free.playerId;
  }

  /**
   * When each group may start claiming slots: the first moment enough of its
   * people are inside the lines.
   *
   * Computed up front rather than decided in the loop, because the loop only
   * moves forward and "no frame ever qualifies" has to fall back to the FIRST
   * frame, not the last. A badly marked court, or a drill happening at one end
   * only, should still produce a roster -- some roster beats none.
   */
  const seedFrom = new Map<string, number>();
  for (const group of groupKeys) {
    const want = (hasSides ? slotsPerSide : slotsPerSide * 2);
    const qualifying = byFrame.find(
      (f) => (f.groups.get(group) ?? []).filter((c) => plane.onCourtStrict(c.pos)).length >= want
    );
    seedFrom.set(group, qualifying ? qualifying.t : -Infinity);
  }

  for (const frame of byFrame) {
    for (const group of groupKeys) {
      const mine = slots.filter((s) => s.group === group);
      const cands = [...(frame.groups.get(group) ?? [])]
        // Most confident first, so when there are more bodies than slots the
        // ones dropped are the marginal detections rather than arbitrary ones.
        .sort((a, b) => b.confidence - a.confidence);
      if (cands.length === 0) continue;

      // SEED ON PEOPLE WHO ARE ON THE COURT, and wait until there are enough
      // of them.
      //
      // This used to seed on the first frame containing anybody at all, taking
      // the most confident detections. Confidence is a detector score, not a
      // statement about who is playing: somebody standing near the camera is
      // large, sharp and extremely confident, while a real player at the far
      // baseline is small and blurry. So a clip that opens with people walking
      // on, or with a queue beside the near sideline, handed its slots to
      // bystanders -- who then held them for the rest of the clip, because a
      // seeded slot is only ever reassigned to whoever is nearest it.
      //
      // Waiting costs the frames before play starts, which is the warm-up this
      // is trying not to track. If the clip NEVER shows enough people inside
      // the lines -- a badly marked court, or a drill at one end -- the old
      // behaviour is the fallback, because some roster beats none.
      const unseeded = mine.filter((s) => s.last === null);
      if (unseeded.length === mine.length) {
        // Decided before the loop, so "never enough people on court" falls
        // back to seeding at the very first frame rather than at the last --
        // which would track almost nothing at all.
        if (frame.t < (seedFrom.get(group) ?? -Infinity)) continue;
        const onCourt = cands.filter((c) => plane.onCourtStrict(c.pos));
        const pool = onCourt.length >= mine.length ? onCourt : cands;
        // Left to right, so the numbering is stable and meaningful rather than
        // whatever order the detector happened to emit.
        const seeds = [...pool].slice(0, mine.length).sort((a, b) => a.pos.x - b.pos.x);
        // An anchored slot is seeded on whoever looks most like its anchor,
        // not on whoever happens to be leftmost -- otherwise the first frames
        // of the "you" slot are your partner until the costs pull it across.
        const order = bestAnchorOrder(mine, seeds, plane);
        order.forEach((ci, si) => { if (ci !== null) place(mine[si], seeds[ci], frame.t, plane.kind); });
        droppedSurplus += Math.max(0, cands.length - mine.length);
        continue;
      }

      const taken = assign(mine, cands, frame.t, plane);
      for (const [slotIdx, candIdx] of taken) place(mine[slotIdx], cands[candIdx], frame.t, plane.kind);
      droppedSurplus += Math.max(0, cands.length - taken.length);
    }
  }

  // ---- relabel: which slot was really the tapped person, frame by frame ---
  const selfSlot = slots.find((sl) => sl.playerId === roles.self);
  if (selfSlot) relabelToAnchor(selfSlot, slots.filter((sl) => sl.group === selfSlot.group));
  const partnerSlot = slots.find((sl) => sl.playerId === roles.partner);
  if (partnerSlot) {
    relabelToAnchor(partnerSlot, slots.filter((sl) => sl.group === partnerSlot.group && sl !== selfSlot));
  }

  const tracks: PlayerTrack[] = slots
    .filter((s) => s.points.length > 0)
    .map((s) => ({ playerId: s.playerId, points: s.points }));

  return {
    tracks, plane: plane.kind, split,
    detectionsSeen, droppedOffCourt, droppedNoCourt, droppedSurplus,
    roles: {
      self: roles.self && tracks.some((t) => t.playerId === roles.self) ? roles.self : null,
      partner: roles.partner && tracks.some((t) => t.playerId === roles.partner) ? roles.partner : null,
    },
  };
}

/**
 * What it costs to call this detection the person this slot is anchored to.
 * Zero for an unanchored slot.
 *
 * Weighted above the running appearance term (3 on the court) because this is
 * the one picture of the player that cannot have drifted: a body that looks
 * nothing like the tapped person costs about as much as eight feet of
 * distance. Build only once the anchor has enough readings to be a shape.
 */
function anchorCost(slot: Slot, c: Cand, plane: Plane): number {
  const a = slot.anchor;
  if (!a) return 0;
  const look = a.appearance && c.appearance
    ? appearanceDistance(a.appearance, c.appearance) * (plane.kind === "court" ? 8 : 1.3)
    : 0;
  const shape = a.build && c.build && a.buildSamples >= 3
    ? buildDistance(a.build, c.build) * (plane.kind === "court" ? 3 : 0.5)
    : 0;
  return look + shape;
}

/** Seeds (already chosen) to slots, cheapest anchor fit first. Index per slot, or null. */
function bestAnchorOrder(slots: Slot[], seeds: Cand[], plane: Plane): Array<number | null> {
  const n = Math.min(slots.length, seeds.length);
  const identity = slots.map((_, i) => (i < n ? i : null));
  if (!slots.some((sl) => sl.anchor)) return identity;
  let best = identity;
  let bestCost = Infinity;
  for (const perm of permutations([...Array(seeds.length).keys()])) {
    let cost = 0;
    for (let i = 0; i < n; i++) cost += anchorCost(slots[i], seeds[perm[i]], plane);
    if (cost < bestCost) { bestCost = cost; best = slots.map((_, i) => (i < n ? perm[i] : null)); }
  }
  return best;
}

/**
 * The tapped person's fixed picture: the detection under the tap, followed a
 * second either way and averaged, so one frame's lighting or pose is not the
 * whole description.
 */
function anchorRef(
  a: RosterAnchor,
  byFrame: Array<{ t: number; groups: Map<string, Cand[]> }>,
  plane: Plane,
): AnchorRef | null {
  let fi = -1;
  let gap = Infinity;
  byFrame.forEach((f, i) => {
    const g = Math.abs(f.t - a.timestampSeconds);
    if (g < gap) { gap = g; fi = i; }
  });
  if (fi < 0 || gap > 0.6) return null;
  const all = (f: { groups: Map<string, Cand[]> }) =>
    [...f.groups.entries()].flatMap(([g, cs]) => cs.map((c) => ({ g, c })));
  const bx = a.box;
  const feetX = bx.x + bx.width / 2, feetY = bx.y + bx.height;
  const inside = all(byFrame[fi]).filter(({ c }) => {
    const fx = c.box.x + c.box.width / 2, fy = c.box.y + c.box.height;
    const padX = Math.max(bx.width * 0.5, bx.height * 0.15);
    return fx >= bx.x - padX && fx <= bx.x + bx.width + padX
      && Math.abs(fy - feetY) <= bx.height * 0.35;
  });
  if (inside.length === 0) return null;
  const hit = inside.reduce((b, x) => {
    const d = (o: typeof x) => Math.hypot(o.c.box.x + o.c.box.width / 2 - feetX, o.c.box.y + o.c.box.height - feetY);
    return d(x) < d(b) ? x : b;
  });

  let appearance = hit.c.appearance;
  let build = hit.c.build;
  let buildSamples = build ? 1 : 0;
  // A second either way, one step at a time, taking the nearest body to where
  // the last one was -- tight enough that a partner a stride away is not it.
  for (const dir of [1, -1]) {
    let last = hit.c;
    for (let i = fi + dir; i >= 0 && i < byFrame.length; i += dir) {
      if (Math.abs(byFrame[i].t - byFrame[fi].t) > 1.0) break;
      const cands = byFrame[i].groups.get(hit.g) ?? [];
      let next: Cand | null = null;
      let nd = Infinity;
      for (const c of cands) {
        const d = Math.hypot(c.pos.x - last.pos.x, c.pos.y - last.pos.y) / Math.max(1e-6, (c.unit + last.unit) / 2);
        if (d < nd) { nd = d; next = c; }
      }
      if (!next || nd > plane.maxPredict * 0.5) break;
      if (next.appearance) appearance = appearance ? blend(appearance, next.appearance, 0.2) : next.appearance;
      if (next.build) { build = build ? blendBuild(build, next.build, 0.2) : next.build; buildSamples += 1; }
      last = next;
    }
  }
  return { role: a.role, group: hit.g, appearance, build, buildSamples };
}

function place(slot: Slot, c: Cand, t: number, kind: "court" | "image"): void {
  if (slot.last !== null && slot.lastT !== null && t > slot.lastT) {
    const dt = t - slot.lastT;
    slot.velocity = { x: (c.pos.x - slot.last.x) / dt, y: (c.pos.y - slot.last.y) / dt };
  }
  slot.last = c.pos;
  slot.lastT = t;
  // A slow average on the ruler too, for the same reason as the appearance
  // below: one frame where a player is half behind their partner halves their
  // box height, and a halved ruler doubles every distance measured against it.
  slot.unit = slot.unit === null ? c.unit : slot.unit * 0.8 + c.unit * 0.2;
  if (c.appearance) {
    // A slow average, so one frame where a player is half behind their partner
    // does not rewrite what they look like.
    slot.appearance = slot.appearance
      ? blend(slot.appearance, c.appearance, 0.2)
      : c.appearance;
  }
  if (c.build) {
    // SLOWER THAN THE COLOUR, because a shape reading is noisier than a colour
    // one: a player mid-lunge is genuinely a different set of ratios for that
    // frame, where their shirt is the same shirt. A tenth-weight running mean
    // over a whole clip is what makes this a shape rather than a pose.
    slot.build = slot.build ? blendBuild(slot.build, c.build, 0.1) : c.build;
    slot.buildSamples += 1;
  }
  slot.looks.push(c.appearance);
  slot.points.push({
    timestampSeconds: t,
    boxImageNorm: c.box,
    confidence: c.confidence,
    // Only the court plane produces court coordinates. On the image plane
    // these are body heights on a screen, which is not a place on a court, and
    // handing them to anything that measures in feet would be a fabrication.
    courtPosition: kind === "court" ? { x: c.pos.x, y: c.pos.y } : null,
  });
}

/**
 * The best pairing of slots to detections in one group.
 *
 * Brute force over permutations, which is fine and will stay fine: there are
 * at most two slots a side, so at most two orderings to compare. A greedy
 * nearest-first pass would be cheaper and wrong in the case that matters --
 * two players converging at the kitchen, where the greedy choice takes the
 * globally worse pairing and swaps their identities for the rest of the point.
 */
function assign(slots: Slot[], cands: Cand[], t: number, plane: Plane): Array<[number, number]> {
  // FEWER PAIRS WHEN ALL OF THEM CANNOT BE MADE. This tried only the largest
  // number of pairs, and when no complete pairing was feasible -- one body
  // reachable by one slot, another reachable by nobody -- it assigned NOTHING,
  // so a player standing in plain view went untracked for that frame.
  for (let k = Math.min(slots.length, cands.length); k > 0; k--) {
    const got = assignK(slots, cands, t, plane, k);
    if (got.length > 0) return got;
  }
  return [];
}

function assignK(slots: Slot[], cands: Cand[], t: number, plane: Plane, k: number): Array<[number, number]> {

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
          const c = cost1(slots[slotCombo[i]], cands[perm[i]], t, plane);
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
 * How stale a slot may be and still follow its player off the court.
 *
 * ONE FRAME at the 5fps this runs at. Half a second was tried first and a
 * test caught it: two frames of a hidden player allowed ten feet at running
 * speed, which is exactly the distance to somebody standing by the fence.
 * The cost is that a player lost while outside the lines is picked up again
 * when they step back in, not while they are still out there.
 */
const OFF_COURT_FOLLOW_S = 0.3;

/**
 * Faster than anybody runs on a pickleball court (a sprint is ~20 ft/s),
 * so a real player is never refused for it. Only checked off the court.
 */
const MAX_RUN_FT_PER_S = 25;

function cost1(slot: Slot, c: Cand, t: number, plane: Plane): number | null {
  if (slot.last === null) return 50; // an unseeded slot takes anything, at a price
  // EVERY DISTANCE BELOW IS IN BODY LENGTHS, which is what lets one set of
  // limits govern both planes: on a court a body length is defined as one foot
  // so the numbers are the old ones unchanged, and on the image it is the
  // player's own box height so the far court is judged as generously as the
  // near one despite being a third the pixels.
  const unit = Math.max(1e-6, ((slot.unit ?? c.unit) + c.unit) / 2);
  const dt = slot.lastT === null ? 0 : Math.min(MAX_PREDICT_S, Math.max(0, t - slot.lastT));
  let predicted = slot.last;
  if (slot.velocity) {
    const dx = slot.velocity.x * dt, dy = slot.velocity.y * dt;
    const mag = Math.hypot(dx, dy) / unit;
    const k = mag > plane.maxPredict ? plane.maxPredict / mag : 1;
    predicted = { x: slot.last.x + dx * k, y: slot.last.y + dy * k };
  }
  const d = Math.hypot(c.pos.x - predicted.x, c.pos.y - predicted.y) / unit;
  // FEASIBILITY IS JUDGED AGAINST THE LAST KNOWN POSITION, ranking against the
  // prediction. A prediction is a guess and must never be able to rule a real
  // detection out; where the player actually was is a fact.
  const fromLast = Math.hypot(c.pos.x - slot.last.x, c.pos.y - slot.last.y) / unit;
  // THE LIMIT GROWS WHILE THEY ARE GONE. Sixteen feet is how far somebody
  // gets between two samples; somebody unseen for two seconds can be anywhere
  // on their half. A fixed limit meant a player who reappeared further than
  // that from where they vanished could never get their own slot back -- it
  // sat empty for the rest of the clip while its player went untracked.
  const goneFor = slot.lastT === null ? 0 : Math.max(0, t - slot.lastT - 0.25);
  const reach = plane.maxJump + goneFor * (plane.kind === "court" ? 15 : 2.5);
  if (Math.min(d, fromLast) > reach) return null;
  // OFF THE COURT, A SLOT MAY ONLY BE FOLLOWED THERE, NEVER JUMP THERE.
  //
  // The six-foot margin exists so a player chasing a wide ball stays tracked.
  // It also admits whoever is standing by the fence, and the slot jump limit
  // (sixteen feet) let a slot whose player had been hidden for a moment land
  // on that bystander -- who then held it, being stationary and therefore
  // always the nearest thing to where the slot last was. Reported from real
  // footage: the read ringed a man drinking water beside the court.
  //
  // So a candidate outside the lines is only this slot if the slot was seen a
  // moment ago and close by: a player walking out, not a slot teleporting.
  // Inside the lines nothing changes.
  if (!plane.onCourtStrict(c.pos)) {
    const gap = slot.lastT === null ? Infinity : t - slot.lastT;
    if (gap > OFF_COURT_FOLLOW_S) return null;
    // At running speed from where they were, on the court plane where a foot
    // is a foot. A bystander a few strides off is not reachable in one frame.
    if (fromLast > MAX_RUN_FT_PER_S * Math.max(gap, 0.2)) return null;
  }
  // Appearance is worth a couple of body lengths, no more. It breaks ties
  // between two players standing close together; it never overrules where they
  // are. Half a body on the image plane, where the same weight in court feet
  // would be three whole players' width.
  const look = slot.appearance && c.appearance
    ? appearanceDistance(slot.appearance, c.appearance) * (plane.kind === "court" ? 3 : 0.5)
    : 0;
  // BUILD, the axis clothing cannot touch. Two partners in matching kit are
  // nearly invisible to colour; they are rarely the same proportions. Weighted
  // below appearance because it is measured off a 2D projection of a person
  // who bends, turns and gets foreshortened, so a single frame's reading is
  // much noisier than a colour -- and ignored entirely until the slot has seen
  // enough of them to have an average worth comparing against, because one
  // reading is a pose, not a shape.
  const shape = slot.build && c.build && slot.buildSamples >= MIN_BUILD_SAMPLES
    ? buildDistance(slot.build, c.build) * (plane.kind === "court" ? 1.5 : 0.25)
    : 0;
  // WHERE SOMEBODY WAS STOPS MEANING MUCH ONCE THEY HAVE BEEN GONE A WHILE.
  // A second behind their partner and a player can be anywhere on their half
  // -- stacking pairs swap sides exactly then -- so the distance from a stale
  // position is ranked more softly the staler it is, and what they look like
  // gets the say it deserves. Feasibility above is untouched.
  const soften = 1 + 1.5 * Math.min(goneFor, 2);
  return d / soften + look + shape + anchorCost(slot, c, plane);
}

/**
 * How many readings a slot needs before its build is allowed to judge anybody.
 *
 * One reading is a pose rather than a shape: a player reaching for a low ball
 * has a short torso and long-looking legs for that frame. Ten samples of a
 * moving person average most of that out, and ten frames is two seconds at the
 * rate this pipeline samples.
 */
const MIN_BUILD_SAMPLES = 10;

/**
 * How much weight each band carries when all three are present.
 *
 * The torso leads because it is the largest, best-lit and least often occluded
 * region, so on players in different kit it is the most reliable single cue.
 * That ranking does NOT need reversing for matching kit: two identical shirts
 * produce a torso distance of zero, which contributes nothing to a weighted
 * mean, so the head and leg terms decide it between them automatically.
 */
const BAND_WEIGHTS = { head: 0.25, torso: 0.45, legs: 0.30 } as const;

/** 0 (identical) to 1 (opposite), on hue with saturation and value as support. */
function bandDistance(a: ColourBand, b: ColourBand): number {
  let dh = Math.abs(a.h - b.h) % 360;
  if (dh > 180) dh = 360 - dh;
  // Hue is meaningless on a grey or black shirt, so it counts for less the
  // less saturated the two are -- otherwise two players in black are compared
  // on the noise in their hue readings.
  const sat = Math.min(a.s, b.s);
  const hue = (dh / 180) * sat;
  // BRIGHTNESS TAKES OVER WHERE HUE CANNOT, rather than staying at a fixed
  // small weight. With hue scaled down on desaturated pairs and nothing put in
  // its place, the whole comparison went quiet on exactly the colours people
  // wear on their feet -- white shoes against black shoes scored 0.25, barely
  // above noise, which is absurd for the most visually opposite pair there is.
  // Caught by a test with two players in the same shirt and different shoes.
  //
  // The cost of this is real and worth stating: brightness moves with sun and
  // shadow, so a strong value term can make one player in shade look like
  // somebody else. It is scaled by the saturation that is missing, so a
  // brightly coloured shirt crossing into shadow keeps the gentle old
  // treatment and only the grey-and-white end of the range leans on value.
  const value = Math.abs(a.v - b.v) * (1 - sat * 0.6);
  return Math.min(1, hue + value + Math.abs(a.s - b.s) * 0.3);
}

/**
 * 0 (identical) to 1 (opposite), over whichever bands both signatures have.
 *
 * RENORMALISED OVER THE BANDS PRESENT, not divided by a fixed total. A player
 * whose legs are hidden behind the net would otherwise score as a closer match
 * to everybody -- the missing term reads as agreement -- which is precisely
 * backwards, and worst at the far end of the court where the net cuts the
 * bodies off.
 */
export function appearanceDistance(a: AppearanceSignature, b: AppearanceSignature): number {
  let sum = 0;
  let weight = 0;
  for (const band of ["head", "torso", "legs"] as const) {
    const x = a[band];
    const y = b[band];
    if (!x || !y) continue;
    sum += bandDistance(x, y) * BAND_WEIGHTS[band];
    weight += BAND_WEIGHTS[band];
  }
  // No band in common is not "identical". Returning 0 would make a pair with
  // nothing to compare look like a perfect match and outrank a real one.
  if (weight === 0) return 0.5;
  return sum / weight;
}

function blendBand(a: ColourBand, b: ColourBand, w: number): ColourBand {
  // Hue is circular: averaging 350 and 10 the naive way gives 180, the exact
  // opposite colour.
  const rad = (d: number) => (d * Math.PI) / 180;
  const x = Math.cos(rad(a.h)) * (1 - w) + Math.cos(rad(b.h)) * w;
  const y = Math.sin(rad(a.h)) * (1 - w) + Math.sin(rad(b.h)) * w;
  const h = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return { h, s: a.s * (1 - w) + b.s * w, v: a.v * (1 - w) + b.v * w };
}

function blend(a: AppearanceSignature, b: AppearanceSignature, w: number): AppearanceSignature {
  const merge = (x: ColourBand | null, y: ColourBand | null) =>
    x && y ? blendBand(x, y, w) : (y ?? x);
  return {
    head: merge(a.head, b.head),
    torso: merge(a.torso, b.torso),
    legs: merge(a.legs, b.legs),
  };
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

/**
 * Give the anchored slot, at every frame, the body that was really its person.
 *
 * WHY A SECOND PASS. The frame-by-frame assignment only ever looks one step
 * back, so once a slot has been handed to the wrong body -- a teammate after
 * an overlap -- the next frame compares against the wrong body's position and
 * keeps it. This looks at the WHOLE clip at once: at each frame, which of the
 * slots on the tapped person's side holds somebody who looks like the tapped
 * person, with a price on changing answer so one badly-lit frame cannot flip
 * it. Where the answer is a different slot, the two slots trade that frame's
 * points, so both tracks come out whole and consistent.
 *
 * Only as good as the colours: two players in identical kit give it nothing to
 * choose on, and then it changes nothing, which is the honest outcome.
 */
function relabelToAnchor(anchored: Slot, group: Slot[]): number {
  const ref = anchored.anchor?.appearance;
  if (!ref || group.length < 2) return 0;
  const selfIdx = group.indexOf(anchored);
  if (selfIdx < 0) return 0;
  const byT = group.map((sl) => new Map(sl.points.map((p, i) => [p.timestampSeconds, i])));
  const times = [...new Set(group.flatMap((sl) => sl.points.map((p) => p.timestampSeconds)))].sort((a, b) => a - b);
  if (times.length === 0) return 0;
  const SWITCH = 1.2, ABSENT = 0.6, UNSEEN_LOOK = 0.35;
  const emit = (k: number, t: number) => {
    const i = byT[k].get(t);
    if (i === undefined) return ABSENT;
    const look = group[k].looks[i];
    return look ? appearanceDistance(ref, look) : UNSEEN_LOOK;
  };
  // Viterbi over "which slot holds the tapped person".
  const K = group.length;
  let cost = group.map((_, k) => emit(k, times[0]) + (k === selfIdx ? 0 : SWITCH));
  const back: number[][] = [];
  for (let ti = 1; ti < times.length; ti++) {
    const next: number[] = [];
    const from: number[] = [];
    for (let k = 0; k < K; k++) {
      let best = Infinity, arg = 0;
      for (let j = 0; j < K; j++) {
        const c = cost[j] + (j === k ? 0 : SWITCH);
        if (c < best) { best = c; arg = j; }
      }
      next.push(best + emit(k, times[ti]));
      from.push(arg);
    }
    back.push(from);
    cost = next;
  }
  let state = cost.indexOf(Math.min(...cost));
  const path = new Array<number>(times.length);
  for (let ti = times.length - 1; ti >= 0; ti--) {
    path[ti] = state;
    if (ti > 0) state = back[ti - 1][state];
  }
  // Trade points wherever the answer is another slot.
  let traded = 0;
  times.forEach((t, ti) => {
    const k = path[ti];
    if (k === selfIdx) return;
    const other = group[k];
    const iSelf = byT[selfIdx].get(t);
    const iOther = byT[k].get(t);
    if (iOther === undefined) return;
    const pOther = other.points[iOther], lOther = other.looks[iOther];
    if (iSelf !== undefined) {
      other.points[iOther] = anchored.points[iSelf];
      other.looks[iOther] = anchored.looks[iSelf];
      anchored.points[iSelf] = pOther;
      anchored.looks[iSelf] = lOther;
    } else {
      other.points.splice(iOther, 1);
      other.looks.splice(iOther, 1);
      anchored.points.push(pOther);
      anchored.looks.push(lOther);
      byT[k] = new Map(other.points.map((p, i) => [p.timestampSeconds, i]));
    }
    traded += 1;
  });
  if (traded > 0) {
    for (const sl of [anchored, ...group]) {
      const order = sl.points.map((_, i) => i).sort((a, b) => sl.points[a].timestampSeconds - sl.points[b].timestampSeconds);
      sl.points = order.map((i) => sl.points[i]);
      sl.looks = order.map((i) => sl.looks[i]);
    }
  }
  return traded;
}
