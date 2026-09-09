import type { CoachingObservationRow } from "@/lib/db/types";

/**
 * Which coaching point leads, and in what order the rest follow.
 *
 * This exists so that the page, the workspace and the read panel agree on one
 * answer. They must, because the rule the whole coaching UI now follows is
 * that EVERY point renders exactly once: the top priority leads the read below
 * the workspace, rally-tagged points appear beside the video when their rally
 * is selected, and points tied to no rally appear in the read. If two views
 * disagreed about which one is the priority, the same paragraph would show up
 * twice again — which is the thing this replaced.
 *
 * Ordering is deterministic on purpose. Severity is a small integer, so ties
 * are the common case, not the exception; falling back to rally order and then
 * to id keeps a re-render from reshuffling the list under the user.
 */
export function rankObservations(observations: CoachingObservationRow[]): CoachingObservationRow[] {
  return [...observations].sort((a, b) => {
    // Weaknesses first: a strength is confirmation, not something to act on.
    const aw = a.valence === "weakness" ? 0 : 1;
    const bw = b.valence === "weakness" ? 0 : 1;
    if (aw !== bw) return aw - bw;
    if (a.severity !== b.severity) return b.severity - a.severity;
    const ar = a.rally_idx ?? Number.MAX_SAFE_INTEGER;
    const br = b.rally_idx ?? Number.MAX_SAFE_INTEGER;
    if (ar !== br) return ar - br;
    return a.id.localeCompare(b.id);
  });
}

/**
 * The one thing to work on first, or null when the model only found strengths.
 *
 * Null is a real answer and must stay one: inventing a "priority fix" out of a
 * clip where nothing went wrong would be exactly the kind of padding the rest
 * of this product refuses to do.
 */
export function topPriorityObservation(
  observations: CoachingObservationRow[]
): CoachingObservationRow | null {
  const ranked = rankObservations(observations);
  const first = ranked[0];
  return first && first.valence === "weakness" ? first : null;
}
