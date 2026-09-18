/**
 * How many seconds of footage a piece of evidence is.
 *
 * ITS OWN FILE because evidence-clips.ts reaches for ffmpeg, storage and the
 * deployment config the moment it is imported, so the one piece of arithmetic
 * in it could not be tested without standing all that up. It went untested for
 * exactly that reason, and the case it got wrong shipped: a claim about a whole
 * rally was given the same shot-length window as a claim about one contact.
 */

/** Seconds of approach and follow-through around a cited contact. */
export const LEAD_S = 2.0;
export const TRAIL_S = 1.5;

/**
 * The seconds of footage one request turns into.
 *
 * Extracted so it can be tested at all. It used to be two expressions inline
 * in a loop that also downloads, transcodes and uploads -- which is why the
 * case it got wrong went unnoticed: a claim about a whole rally was given the
 * same shot-length window as a claim about one contact.
 */
export function clipWindow(
  req: { tSeconds: number; endSeconds?: number },
  clipSeconds: number
): { startSeconds: number; endSeconds: number } {
  // An explicit end means the caller is describing a passage, not a moment,
  // and tSeconds is where it starts rather than what it is centred on.
  if (req.endSeconds !== undefined) {
    return {
      startSeconds: Math.max(0, req.tSeconds),
      endSeconds: Math.min(clipSeconds, req.endSeconds),
    };
  }
  return {
    startSeconds: Math.max(0, req.tSeconds - LEAD_S),
    endSeconds: Math.min(clipSeconds, req.tSeconds + TRAIL_S),
  };
}

