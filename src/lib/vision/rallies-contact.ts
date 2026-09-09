/**
 * Rallies from paddle contacts on both sides.
 *
 * A rally is a ball being hit back and forth. So: group the contacts by the
 * gaps between them, and keep a group only if BOTH sides of the net hit the
 * ball in it. One side hitting alone is a serve into the net, a feed, or
 * somebody warming up against a wall of nobody -- a point may have happened,
 * but a rally did not.
 *
 * This replaces segmenting on net crossings. Crossings had to decide which
 * side of the net a ball in flight was on, which from behind a baseline is
 * genuinely undecidable inside the net band -- the tape is ~73px tall in the
 * image while the whole far court is ~44px. A contact does not have that
 * problem: it is attributed to the player who made it, and the players are
 * tracked on the ground plane where the court geometry is exact.
 *
 * The lead-in is longer than the old one (2s rather than 1.5) because the
 * anchor moved. A crossing happens mid-rally; the first contact IS the serve,
 * and the serve motion, the bounce and the toss all precede it.
 */

import type { BallHit } from "./ball";
import type { ClusteredRally } from "./rallies";

export type CourtSide = "near" | "far";

export interface ContactRallyParams {
  /** Kept before the first contact. The serve motion precedes the strike. */
  leadS: number;
  /** Kept after the last contact. */
  tailS: number;
  /** Longest quiet spell between contacts that is still the same rally. */
  maxGapS: number;
  /**
   * Require both sides to have hit the ball. Turning this off makes any burst
   * of contacts a rally, which is what hit-clustering used to do.
   */
  requireBothSides: boolean;
  /** Contacts a rally needs at minimum, regardless of sides. */
  minContacts: number;
}

export const CONTACT_RALLY_PARAMS: ContactRallyParams = {
  leadS: 2,
  tailS: 1.5,
  // Pickleball has long pauses inside a rally -- a lob hangs, a player chases
  // a deep ball. Contacts are more frequent than crossings were, so this can
  // be tighter than the crossing gap without splitting real rallies.
  maxGapS: 3,
  requireBothSides: true,
  minContacts: 2,
};

export interface ContactRally extends ClusteredRally {
  /** Contacts attributed to each side, for the coaching layer and for debugging. */
  nearContacts: number;
  farContacts: number;
  unknownContacts: number;
  firstContactS: number;
  lastContactS: number;
}

/** Contacts that never became a rally, with why. */
export interface DeadContactGroup {
  startS: number;
  endS: number;
  contacts: number;
  reason: "one-side-only" | "too-few-contacts";
  side: CourtSide | null;
}

/**
 * Group contacts into rallies.
 *
 * `sideOf` returns which half of the court made the contact, or null when it
 * could not be attributed -- a contact nobody was near. Unknown contacts count
 * toward the rally's length but cannot satisfy the both-sides test on their
 * own, because "we do not know who hit it" is not evidence that two people did.
 */
export function clusterRalliesFromContacts(
  hits: BallHit[],
  sideOf: (h: BallHit) => CourtSide | null,
  durationSeconds: number,
  params: ContactRallyParams = CONTACT_RALLY_PARAMS
): { rallies: ContactRally[]; dead: DeadContactGroup[] } {
  if (hits.length === 0) return { rallies: [], dead: [] };
  const sorted = [...hits].sort((a, b) => a.t - b.t);

  const groups: BallHit[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const g = groups[groups.length - 1];
    if (sorted[i].t - g[g.length - 1].t > params.maxGapS) groups.push([sorted[i]]);
    else g.push(sorted[i]);
  }

  const rallies: ContactRally[] = [];
  const dead: DeadContactGroup[] = [];

  for (const g of groups) {
    const sides = g.map(sideOf);
    const near = sides.filter((s) => s === "near").length;
    const far = sides.filter((s) => s === "far").length;
    const unknown = sides.filter((s) => s === null).length;
    const first = g[0].t;
    const last = g[g.length - 1].t;

    if (g.length < params.minContacts) {
      dead.push({ startS: first, endS: last, contacts: g.length,
                  reason: "too-few-contacts", side: near > 0 ? "near" : far > 0 ? "far" : null });
      continue;
    }
    if (params.requireBothSides && (near === 0 || far === 0)) {
      dead.push({ startS: first, endS: last, contacts: g.length,
                  reason: "one-side-only", side: near > 0 ? "near" : far > 0 ? "far" : null });
      continue;
    }

    rallies.push({
      idx: rallies.length + 1,
      startS: Math.max(0, first - params.leadS),
      endS: Math.min(durationSeconds, last + params.tailS),
      contacts: g.map((h) => h.t),
      nearContacts: near,
      farContacts: far,
      unknownContacts: unknown,
      firstContactS: first,
      lastContactS: last,
    });
  }
  return { rallies, dead };
}

/**
 * OFF by default. Turn on with `CONTACT_RALLIES=on`.
 *
 * Tried as the primary segmenter and withdrawn: it needs a contact to be
 * detected and attributed to a side before a rally can exist, and on this
 * footage the ball is seen in about a quarter of frames -- too sparse for
 * every real contact to be found, so real rallies go missing entirely. Net
 * crossings degrade better, because one crossing can be inferred from a
 * trajectory that was only partly observed, where a contact cannot.
 *
 * Kept rather than deleted: the argument for it is sound and it becomes the
 * better method the moment ball coverage improves. A higher camera, or a ball
 * model trained on this angle, is what would change that.
 */
export function contactRalliesEnabled(): boolean {
  const v = (process.env.CONTACT_RALLIES || "off").toLowerCase();
  return v === "on" || v === "1" || v === "true";
}
