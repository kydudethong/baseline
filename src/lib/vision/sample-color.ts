/**
 * Sampling a court line's colour from a pixel the user clicked.
 *
 * The naive version -- take the one pixel under the cursor -- is wrong often
 * enough to matter. A painted line is two or three pixels wide in a 720p
 * frame, video compression smears its edges toward the surface colour, and
 * nobody clicks dead centre. So the single pixel under the cursor is
 * frequently a blend of paint and court.
 *
 * The obvious repair -- average or median a patch around the click -- is
 * worse. A 5x5 patch centred on a 3px line is mostly *court*, so its median
 * is the surface, and its mean is the surface pulled slightly toward the
 * paint. Either would hand the fitter the colour of the thing it is trying
 * to tell the lines apart from.
 *
 * So: anchor on the clicked pixel, then average only its neighbours that
 * are already close to it. Noise and compression get averaged out; the
 * surface pixels a few pixels away are excluded because they are not close
 * to the seed in the first place. The agreement figure reports how much of
 * the patch qualified, which is the honest signal for "that click did not
 * land on a line" -- a click on a large flat region agrees ~100%, a click on
 * a thin line agrees far less, and a click on an edge agrees least of all.
 */

export interface SampledColor {
  /** `#rrggbb`, lowercase. */
  hex: string;
  /** Fraction of the sampled patch that matched the clicked pixel, 0..1. */
  agreement: number;
}

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((n) => clamp255(n).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * @param rgba    Row-major RGBA, as `CanvasRenderingContext2D.getImageData` returns.
 * @param width   Width of that buffer in pixels.
 * @param height  Height of that buffer in pixels.
 * @param cx, cy  The clicked pixel, in the buffer's own coordinates.
 * @param radius  Half-width of the patch considered. 2 gives a 5x5.
 * @param tolerance Euclidean RGB distance within which a neighbour counts as
 *                  the same paint. 40 is roughly "the same colour, allowing
 *                  for compression" -- wide enough to absorb the noise in an
 *                  8-bit H.264 frame, narrow enough that a green court does
 *                  not qualify as a blue line.
 */
export function sampleLineColor(
  rgba: Uint8ClampedArray | number[],
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius = 2,
  tolerance = 40
): SampledColor | null {
  const x0 = Math.round(cx);
  const y0 = Math.round(cy);
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;
  if (x0 < 0 || y0 < 0 || x0 >= width || y0 >= height) return null;

  const at = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return [rgba[i], rgba[i + 1], rgba[i + 2]] as const;
  };

  const [sr, sg, sb] = at(x0, y0);
  let r = 0, g = 0, b = 0, kept = 0, seen = 0;

  for (let y = y0 - radius; y <= y0 + radius; y++) {
    for (let x = x0 - radius; x <= x0 + radius; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      seen++;
      const [pr, pg, pb] = at(x, y);
      const d = Math.hypot(pr - sr, pg - sg, pb - sb);
      if (d > tolerance) continue;
      r += pr; g += pg; b += pb; kept++;
    }
  }

  // kept is at least 1 -- the seed is always within zero distance of itself --
  // so this cannot divide by zero, but being explicit costs nothing.
  if (kept === 0) return { hex: rgbToHex(sr, sg, sb), agreement: 0 };
  return {
    hex: rgbToHex(r / kept, g / kept, b / kept),
    agreement: seen > 0 ? kept / seen : 0,
  };
}
