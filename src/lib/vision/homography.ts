/**
 * Minimal 4-point planar homography (perspective transform) solver — pure
 * TypeScript, no OpenCV binding needed on the Node side (Python/OpenCV is
 * used for court *detection*; this is just the linear-algebra part of
 * mapping an already-detected quadrilateral to a unit square, used by
 * transformToCourtCoordinates()).
 *
 * Standard DLT (Direct Linear Transform) for exactly 4 correspondences:
 * solves the 8x8 linear system for the 8 free parameters of a 3x3
 * projective matrix (the 9th entry is fixed to 1).
 */

export type Point = [number, number];

export interface Homography {
  /** Row-major 3x3 matrix, m[8] === 1. */
  m: number[];
}

function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  // Augment
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Partial pivot
    let pivotRow = col;
    let maxAbs = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > maxAbs) {
        maxAbs = Math.abs(M[r][col]);
        pivotRow = r;
      }
    }
    if (maxAbs < 1e-12) return null; // singular — degenerate quadrilateral
    [M[col], M[pivotRow]] = [M[pivotRow], M[col]];

    const pivot = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= pivot;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }

  return M.map((row) => row[n]);
}

/** src and dst must each have exactly 4 points, in the same corner order. */
export function computeHomography(src: Point[], dst: Point[]): Homography | null {
  if (src.length !== 4 || dst.length !== 4) return null;

  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }

  const solution = solveLinearSystem(A, b);
  if (!solution) return null;

  const [a, bb, c, d, e, f, g, h] = solution;
  return { m: [a, bb, c, d, e, f, g, h, 1] };
}

export function applyHomography(h: Homography, point: Point): Point {
  const [x, y] = point;
  const [a, b, c, d, e, f, g, hh, i] = h.m;
  const w = g * x + hh * y + i;
  if (Math.abs(w) < 1e-9) return [NaN, NaN];
  return [(a * x + b * y + c) / w, (d * x + e * y + f) / w];
}
