/**
 * The court, in feet, projected through a homography. One definition.
 *
 * There were two. SetupCanvas worked in real court feet (20 x 44, net at 22,
 * kitchen lines at 15 and 29) and drew the net with real height; the analysis
 * page's CourtCalibrationEditor worked in a normalized 0..1 model with the
 * kitchen at 7/44 and drew the net as a flat line. Same court, two coordinate
 * systems, two colour schemes, two chances to be subtly wrong — and the one
 * that mattered, the net's HEIGHT, existed in only one of them.
 *
 * Feet won because the rest of the system is already in feet: the Python
 * calibration, shots.ts's zones, and the net band the segmenter decides
 * crossings against all use these numbers. A normalized model is one more
 * conversion between the editor and the thing being edited.
 *
 * Pure geometry — no React, no canvas, no SVG. Both editors project the same
 * segments and draw them however they like.
 */
import { applyHomography, computeHomography, type Homography } from "./homography";

/** A pickleball court is 20 x 44 ft, with a 7 ft non-volley zone each side. */
export const COURT_W = 20;
export const COURT_L = 44;
export const NET_Y = 22;
export const KITCHEN_NEAR_Y = 15;
export const KITCHEN_FAR_Y = 29;

/** Net height at the posts and at the centre, where it sags. */
export const NET_POST_FT = 3.0;
export const NET_CENTRE_FT = 34 / 12;

export type QuadKind = "full" | "near-half";

/** What a segment IS, so a caller can colour by meaning rather than by index. */
export type CourtLineRole = "boundary" | "kitchen" | "centre" | "net" | "net-post";

export interface CourtSegment {
  a: [number, number];
  b: [number, number];
  role: CourtLineRole;
}

/**
 * The homography from court feet to image pixels, given the four marked
 * corners in nearLeft, nearRight, farRight, farLeft order.
 *
 * `quadKind` decides what the far pair means: the far baseline on a full court,
 * or the net when the far baseline is out of frame.
 */
export function courtHomography(
  corners: Array<{ x: number; y: number }>,
  quadKind: QuadKind
): Homography | null {
  if (corners.length !== 4) return null;
  const farY = quadKind === "near-half" ? NET_Y : COURT_L;
  return computeHomography(
    [[0, 0], [COURT_W, 0], [COURT_W, farY], [0, farY]],
    corners.map((c) => [c.x, c.y] as [number, number])
  );
}

/** How many image pixels one court foot spans at the net. Zero if degenerate. */
export function feetToPixelsAtNet(h: Homography): number {
  const a = applyHomography(h, [COURT_W / 2, NET_Y]);
  const b = applyHomography(h, [COURT_W / 2 + 1, NET_Y]);
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/**
 * Every line of the court in image pixels, including the net drawn at its real
 * height.
 *
 * The net's height is not decoration. The segmenter decides which side of the
 * net the ball is on using that height, so an editor that draws only the line
 * on the floor lets someone confirm a court whose net band is wrong without
 * ever seeing it.
 */
export function courtSegments(
  corners: Array<{ x: number; y: number }>,
  quadKind: QuadKind
): CourtSegment[] {
  const h = courtHomography(corners, quadKind);
  if (!h) return [];

  const farY = quadKind === "near-half" ? NET_Y : COURT_L;
  const out: CourtSegment[] = [];
  const seg = (a: [number, number], b: [number, number], role: CourtLineRole) => {
    const p = applyHomography(h, a);
    const q = applyHomography(h, b);
    if (![p[0], p[1], q[0], q[1]].every(Number.isFinite)) return;
    out.push({ a: p, b: q, role });
  };

  seg([0, 0], [COURT_W, 0], "boundary");
  seg([0, 0], [0, farY], "boundary");
  seg([COURT_W, 0], [COURT_W, farY], "boundary");
  seg([0, KITCHEN_NEAR_Y], [COURT_W, KITCHEN_NEAR_Y], "kitchen");
  seg([COURT_W / 2, 0], [COURT_W / 2, KITCHEN_NEAR_Y], "centre");
  seg([0, NET_Y], [COURT_W, NET_Y], "net");

  const ftToPx = feetToPixelsAtNet(h);
  if (ftToPx > 0) {
    const base = [
      applyHomography(h, [0, NET_Y]),
      applyHomography(h, [COURT_W / 2, NET_Y]),
      applyHomography(h, [COURT_W, NET_Y]),
    ];
    if (base.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
      const tape: Array<[number, number]> = [
        [base[0][0], base[0][1] - NET_POST_FT * ftToPx],
        [base[1][0], base[1][1] - NET_CENTRE_FT * ftToPx],
        [base[2][0], base[2][1] - NET_POST_FT * ftToPx],
      ];
      out.push(
        { a: tape[0], b: tape[1], role: "net" },
        { a: tape[1], b: tape[2], role: "net" },
        { a: [base[0][0], base[0][1]], b: tape[0], role: "net-post" },
        { a: [base[2][0], base[2][1]], b: tape[2], role: "net-post" },
      );
    }
  }

  if (quadKind !== "near-half") {
    seg([0, COURT_L], [COURT_W, COURT_L], "boundary");
    seg([0, KITCHEN_FAR_Y], [COURT_W, KITCHEN_FAR_Y], "kitchen");
    seg([COURT_W / 2, KITCHEN_FAR_Y], [COURT_W / 2, COURT_L], "centre");
  }

  return out;
}
