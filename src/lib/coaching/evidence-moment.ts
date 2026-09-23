/**
 * Where a coaching point's footage should start, and whether it is a moment
 * or a whole point.
 *
 * WHY THIS IS NOT JUST "USE THE TIME THE MODEL GAVE". Reported from a real
 * read: a criticism about standing straight-legged on a low reset came with a
 * clip of the players standing upright AFTER the point had ended. They were
 * straight-legged, and the clip proved nothing -- the rally was over, nobody
 * was resetting anything. A time that lands in dead air makes a true sentence
 * look like a lie, which costs more than having no clip at all.
 *
 * So a named time has to be corroborated before it is believed. The measured
 * contacts are the corroboration: each one is a moment somebody's hand
 * accelerated like a swing, they are timed to about a tenth of a second, and
 * they exist independently of anything the model said. A cited time that sits
 * near one is a cited time during play. One that sits near nothing is not,
 * however confident the sentence above it sounds.
 */

export interface MomentInput {
  /** The time the model named, if it named one. */
  namedSeconds: number | null;
  /** Contact times measured from the footage, in any order. */
  contactSeconds: readonly number[];
  /** The rally this point was tagged to, when it had one. */
  rally: { start: number; end: number } | null;
}

export type Moment =
  /** A single contact: play the seconds around it. */
  | { kind: "moment"; tSeconds: number; snappedBy: number }
  /** A whole point: play it start to end. */
  | { kind: "rally"; tSeconds: number; endSeconds: number; reason: "no time named" | "named a moment with no play in it" }
  /** Nothing can be shown, and saying so beats inventing a clip. */
  | { kind: "none"; reason: "no time named" | "named a moment with no play in it" };

/**
 * How far a named time may be from a measured contact and still be that shot.
 *
 * A second. The contacts are timed to about a tenth of a second and a model
 * reading a video clock is off by rather more, so this is generous on purpose
 * -- it is a check for "was anybody playing here at all", not for "did you
 * name the exact frame". Nothing legitimate is a second away from every swing
 * in the clip; a moment between points is several.
 */
export const CONTACT_TOLERANCE_S = 1.0;

export function momentFor(input: MomentInput): Moment {
  const rally = input.rally && input.rally.end > input.rally.start ? input.rally : null;
  const asRally = (reason: "no time named" | "named a moment with no play in it"): Moment =>
    rally
      ? { kind: "rally", tSeconds: rally.start, endSeconds: rally.end, reason }
      : { kind: "none", reason };

  const named = Number.isFinite(input.namedSeconds as number) ? Number(input.namedSeconds) : null;
  if (named === null) return asRally("no time named");

  // The nearest swing to what was named. Snapping to it as well as checking it
  // costs nothing and helps: the contact time came from the footage, the
  // named one came from a model watching a clock.
  let nearest: number | null = null;
  let gap = Infinity;
  for (const c of input.contactSeconds) {
    if (!Number.isFinite(c)) continue;
    const d = Math.abs(c - named);
    if (d < gap) { gap = d; nearest = c; }
  }
  if (nearest !== null && gap <= CONTACT_TOLERANCE_S) {
    return { kind: "moment", tSeconds: nearest, snappedBy: gap };
  }

  // NO CONTACTS AT ALL is not evidence of dead air -- plenty of clips measure
  // none, and on those the named time is the only thing there is. The check
  // only bites when there were swings to compare against.
  if (input.contactSeconds.length === 0) return { kind: "moment", tSeconds: named, snappedBy: 0 };

  // Named a time with no swing near it. If the rally it was tagged to is real,
  // show the rally instead and say it is the rally; otherwise show nothing.
  return asRally("named a moment with no play in it");
}
