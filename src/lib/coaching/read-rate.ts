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
 * EIGHT. It was fifteen for a while and the reason was the BALL rather than the
 * swing: ten is plenty to see a stroke, but a ball travelling thirty miles an
 * hour crosses much of the court between samples, and half the frames it does
 * land in show a streak rather than a dot.
 *
 * Fifteen fixed that by paying for it -- half again the bill, linearly, on top
 * of a high-resolution read, and ten plus high resolution was judged the better
 * of the two ways to spend that money: more detail per frame rather than more
 * frames, on footage where the hard thing to see is small rather than fast.
 *
 * TEN, having been eight for a while, and the reasoning is worth keeping
 * because the number has now moved in both directions. It was cut to eight on
 * the argument that a pickleball stroke lasts roughly a third of a second, so
 * eight samples a second already puts two or three frames inside every swing
 * and ten was not buying a third look at anything. That argument is about
 * SWINGS. The scan pass does not read swings -- it is told outright that it
 * cannot see the paddle -- it reads rallies, and a rally boundary is the
 * instant a ball stopped being played, which is not a third of a second long.
 *
 * The cost is linear and easy to reverse: at high resolution each frame per
 * second is about 46 cents on a twenty-minute game, so this is roughly a
 * dollar more per long clip.
 *
 * If detection gets worse, this is still the first knob to try, in either
 * direction: it is linear, where resolution is a 4x step. Below about 5 a
 * stroke stops being reliably visible and the clamp in analystFps() refuses
 * anything under 3.
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
 * The rate the overlay is WRITTEN at, which is the analyst rate exactly.
 *
 * ONE RATE, NOT THREE. There used to be a floor of 10 here, so the overlay was
 * rendered at 10fps while the model read it at 8 -- a fifth of every frame
 * drawn for nobody. The floor was there because this stage once decimated from
 * the source's 30fps and 10 was what stopped it killing long runs; 8 is fewer
 * frames than 10, so it clears that bar by a wider margin than the floor did.
 *
 * Worth being exact about which rate is which, because there are two and they
 * are easy to confuse from a progress badge:
 *
 *   VISION_FPS (5)   how often the LOCAL computer vision looks at the video --
 *                    players and skeletons. Costs CPU time, no money. This is
 *                    the "5 fps" the preparing-the-video line reports.
 *   ANALYST_FPS (8)  how many frames a second of the finished overlay Gemini
 *                    is given, and now also how many are drawn. This is the
 *                    one with a price on it.
 *
 * Nothing is lost by drawing fewer than the source has: the overlay is a
 * rendering of measurements taken at 5fps, so frames beyond that rate carry
 * interpolation rather than observation either way.
 */
export function overlayFps(): number {
  return analystFps();
}
