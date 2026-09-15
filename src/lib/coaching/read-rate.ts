/**
 * How many frames per second the coaching model reads.
 *
 * ITS OWN MODULE, and the reason is a bug that shipped: the analyst's sample
 * rate was raised to 15fps while the overlay was still being WRITTEN at 10.
 * You cannot sample fifteen distinct frames a second out of a ten-frame-a-
 * second video. Gemini gets duplicates, the extra frames carry no information,
 * and the run is billed at 15fps rates for 10fps of footage -- strictly worse
 * than not having changed it.
 *
 * Two files needed the same number and each had its own idea of it. So the
 * number lives here, the renderer asks for it rather than assuming, and the
 * two cannot drift apart again.
 *
 * Kept free of imports on purpose: the vision layer pulls this in, and it must
 * not drag the Gemini client along with it.
 */

/**
 * Frames per second for the SCAN.
 *
 * Fifteen, and the reason is the BALL rather than the swing. Ten was already
 * enough to see a stroke. Ten is not enough for a ball travelling thirty miles
 * an hour: it crosses much of the court between samples, and the frames it
 * does appear in are as often as not the ones where it is a streak rather than
 * a dot.
 *
 * It costs half again as much, linearly, and it shortens how much video fits
 * in one call to about two and a half minutes.
 */
export const ANALYST_FPS = 15;

/** The rate in force, from ANALYST_FPS, clamped to what is worth paying for. */
export function analystFps(): number {
  const v = Number(process.env.ANALYST_FPS);
  // Below about 3fps a stroke stops being visible at all (it lasts roughly a
  // third of a second), which would silently turn technique back into guesses
  // while still charging for the pass. Above 15 buys nothing a paddle swing
  // needs and shrinks the segment length fast.
  return Number.isFinite(v) && v >= 3 && v <= 15 ? v : ANALYST_FPS;
}

/**
 * The rate the overlay must be WRITTEN at.
 *
 * Never below what the model reads, or the extra samples are duplicates. Never
 * below 10 either: the overlay is also something a person scrubs, and the
 * decimation from 30fps to 10 is what stopped this stage killing long runs.
 */
export function overlayFps(): number {
  return Math.max(10, analystFps());
}
