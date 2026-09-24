/**
 * What the second look made of a read, as the reader is told it.
 *
 * WHY THE READER IS TOLD AT ALL. Every criticism is now re-watched at full
 * detail and the ones the footage contradicts are deleted (see
 * verify-observations.ts). That is invisible: a page with six points looks
 * exactly like a page with six points. The reader of this particular product
 * has just been handed four wrong ones in a row, and "we checked all of them
 * and threw two away" is the only thing that can change what the next six mean
 * to them. A tool that publishes its own error rate is making a claim nobody
 * else in this space is making.
 */

export interface CheckedCounts {
  /** Re-watched and the footage showed it. */
  confirmed: number;
  /** Re-watched and the window could not settle it. Kept, and said so. */
  unclear: number;
  /** Re-watched and the footage showed something else. Deleted. */
  dropped: number;
  /** A few of the deleted titles, for the log and for the curious. */
  droppedTitles?: string[];
  /**
   * The titles the check could not settle, so the page can mark them.
   *
   * BY TITLE, NOT BY ID. The observations are written to their table after
   * this, and adding a column to carry one boolean would be a migration
   * nobody applies automatically -- see deployment.md. Titles inside one read
   * are distinct in practice (the fault-family merge sees to it), and a
   * mismatch costs a missing chip rather than a wrong claim.
   */
  unconfirmedTitles?: string[];
}

export function parseChecked(coachingJson: string | null): CheckedCounts | null {
  if (!coachingJson) return null;
  let parsed: { checked?: unknown };
  try {
    parsed = JSON.parse(coachingJson) as { checked?: unknown };
  } catch {
    return null;
  }
  const c = parsed.checked as Partial<CheckedCounts> | null | undefined;
  if (!c || typeof c !== "object") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  const out: CheckedCounts = {
    confirmed: n(c.confirmed),
    unclear: n(c.unclear),
    dropped: n(c.dropped),
    droppedTitles: Array.isArray(c.droppedTitles)
      ? c.droppedTitles.filter((t): t is string => typeof t === "string").slice(0, 8)
      : undefined,
    unconfirmedTitles: Array.isArray(c.unconfirmedTitles)
      ? c.unconfirmedTitles.filter((t): t is string => typeof t === "string")
      : undefined,
  };
  // Nothing checked is not a result. Reads from before this existed, and reads
  // where every point was clip-wide, have nothing to say here and say nothing.
  return out.confirmed + out.unclear + out.dropped > 0 ? out : null;
}

/** The sentence, or null when there is nothing worth a line. */
export function checkedSentence(c: CheckedCounts | null): string | null {
  if (!c) return null;
  const total = c.confirmed + c.unclear + c.dropped;
  if (total === 0) return null;
  const parts: string[] = [
    `${total} criticism${total === 1 ? "" : "s"} were written and every one was re-watched at full detail`,
  ];
  if (c.dropped > 0) {
    parts.push(`${c.dropped} ${c.dropped === 1 ? "was" : "were"} deleted for not matching the footage`);
  }
  if (c.unclear > 0) {
    parts.push(`${c.unclear} could not be settled from the clip and ${c.unclear === 1 ? "is" : "are"} marked below`);
  }
  if (c.dropped === 0 && c.unclear === 0) parts.push("and all of them held up");
  return `${parts.join(", ")}.`;
}
