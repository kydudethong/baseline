/**
 * Moving coordinates from the space the SERVER measured in to the video's own.
 *
 * THIS HAS GONE WRONG TWICE IN THE SAME FILE. rally_seg caps its long side at
 * 1280, so everything it reports -- court corners, player boxes, feet -- is in
 * that space and not the video's. Painting 1280-space coordinates onto a
 * 1920-wide canvas puts every mark at two-thirds of its real position, bunched
 * toward the top-left. The court corners were fixed once, with a comment
 * explaining exactly this; player boxes were added underneath that comment
 * later and drawn unscaled, and the symptom was reported as "the boxes are
 * randomly placed", which is what a scaling error looks like from outside.
 *
 * So the conversion lives here, named, with tests, instead of as a `* sx`
 * sprinkled at each call site where the next one can be forgotten.
 */

export interface ImageScale {
  sx: number;
  sy: number;
}

/**
 * A detection box: TWO CORNERS, `[x1, y1, x2, y2]`.
 *
 * NAMED BECAUSE THE OTHER READING IS SO PLAUSIBLE. Canvas, CSS and most
 * drawing APIs take `[x, y, width, height]`, and a bare
 * `[number, number, number, number]` looks exactly like one of those -- so the
 * drawing code destructured it as `[bx, by, bw, bh]` and painted every box
 * from the player's head to a point off the bottom of the frame. It was
 * reported, again, as "the boxes aren't on the players".
 *
 * What made it survive was that the TESTS built their fixtures the same wrong
 * way, so they agreed with the bug. A type the compiler checks and one
 * conversion function are worth more here than another comment.
 */
export type BoxPx = [number, number, number, number];

/** The same box as canvas wants it: origin plus a size. */
export function boxRect(b: BoxPx): { x: number; y: number; width: number; height: number } {
  const [x1, y1, x2, y2] = b;
  // Min/max rather than a straight subtraction: a detector that reports its
  // corners in the other order would otherwise give a negative size, which
  // strokeRect draws inside out and hit-testing silently never matches.
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  return { x, y, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

/**
 * The factor between the measured image and the video.
 *
 * Returns 1:1 when either size is unknown, which is the safe answer: on a
 * fresh upload the video's true dimensions are still null in the database and
 * the server falls back to its own frame, so the two spaces already agree.
 * Guessing a ratio from a missing number would break the case that works.
 */
export function imageScale(
  measured: [number, number] | null | undefined,
  videoWidth: number,
  videoHeight: number
): ImageScale {
  const sx = measured && measured[0] > 0 && videoWidth > 0 ? videoWidth / measured[0] : 1;
  const sy = measured && measured[1] > 0 && videoHeight > 0 ? videoHeight / measured[1] : 1;
  return { sx, sy };
}

/** A point, in video pixels. */
export function scalePoint(p: [number, number], s: ImageScale): [number, number] {
  return [p[0] * s.sx, p[1] * s.sy];
}

/** A box as [x1, y1, x2, y2], in video pixels. */
export function scaleBox(b: BoxPx, s: ImageScale): BoxPx {
  return [b[0] * s.sx, b[1] * s.sy, b[2] * s.sx, b[3] * s.sy];
}
