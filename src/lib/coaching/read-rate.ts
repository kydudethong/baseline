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
 * TEN. It was fifteen for a while and the reason was the BALL rather than the
 * swing: ten is plenty to see a stroke, but a ball travelling thirty miles an
 * hour crosses much of the court between samples, and half the frames it does
 * land in show a streak rather than a dot.
 *
 * Fifteen fixed that by paying for it -- half again the bill, linearly, on top
 * of a high-resolution read, and ten plus high resolution was judged the better
 * of the two ways to spend that money: more detail per frame rather than more
 * frames, on footage where the hard thing to see is small rather than fast.
 *
 * If detection gets worse, this is the knob to try before anything else: it is
 * linear, where resolution is a 4x step.
 */
export const ANALYST_FPS = 10;

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
