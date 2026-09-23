/**
 * Is this quad a court, and if not, what is wrong with it?
 *
 * ITS OWN FILE so the SETUP PAGE can ask. court.ts pulls in the Python bridge
 * the moment it is imported, which cannot go in a browser bundle -- and the
 * one place this test is most useful is under the person's finger while they
 * drag a corner, rather than in a limitation line after a run they waited for.
 */

export interface CourtCorners {
  bottomLeft: [number, number];
  bottomRight: [number, number];
  topRight: [number, number];
  topLeft: [number, number];
}

/**
 * What is wrong with this quad, in a sentence a player can act on, or null.
 *
 * THE SHAPE, NOT JUST THE SIZE. The old test asked whether the quad was big
 * enough and deep enough, which catches a detector returning a sliver and
 * nothing else. It passes a quad whose corners have been dragged across each
 * other into a bow tie, or one whose far edge is wider than its near edge --
 * both of which produce a homography that maps the court inside out, and
 * every distance, every zone and every side-of-net answer downstream is then
 * confidently wrong with nothing to show for it on screen.
 *
 * These are the things a camera behind a baseline cannot do:
 *   - cross its own edges (a dragged corner);
 *   - put the far baseline below the near one in the image;
 *   - see a far baseline WIDER than the near one, which perspective forbids;
 *   - see one so narrow it is a vanishing point rather than a line.
 */
export function courtQuadProblem(
  corners: CourtCorners | null,
  frameWidthPx: number,
  frameHeightPx: number,
  quadKind: "full" | "near-half" | "near-inplay" = "full",
): string | null {
  if (!corners || !(frameWidthPx > 0) || !(frameHeightPx > 0)) return "The court corners are missing.";
  const pts = [corners.bottomLeft, corners.bottomRight, corners.topRight, corners.topLeft];
  if (pts.some((p) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) {
    return "The court corners are missing.";
  }

  const area = Math.abs(
    pts.reduce((sum, p, i) => {
      const q = pts[(i + 1) % pts.length];
      return sum + (p[0] * q[1] - q[0] * p[1]);
    }, 0) / 2
  );
  if (area < 0.05 * frameWidthPx * frameHeightPx) {
    return "The marked court covers almost none of the picture — the corners are probably on the wrong lines.";
  }

  const ys = pts.map((p) => p[1]);
  const xs = pts.map((p) => p[0]);
  if (Math.max(...ys) - Math.min(...ys) < 0.12 * frameHeightPx) {
    return "The marked court is a flat band across the frame rather than a court seen in perspective.";
  }
  if (Math.max(...xs) - Math.min(...xs) < 0.20 * frameWidthPx) {
    return "The marked court is too narrow to be a court at this distance.";
  }
  if (quadKind === "full" && Math.max(...ys) - Math.min(...ys) < 0.20 * frameHeightPx) {
    return "This is marked as a whole court but is only a few pixels deep — mark the near half instead.";
  }

  // CONVEX, AND WOUND THE SAME WAY ALL THE WAY ROUND. A dragged corner makes
  // a bow tie, whose cross product flips sign at the crossing.
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4], c = pts[(i + 2) % 4];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-6) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return "Two of the court corners are crossed over each other — drag them back into a rectangle.";
  }

  const nearY = (corners.bottomLeft[1] + corners.bottomRight[1]) / 2;
  const farY = (corners.topLeft[1] + corners.topRight[1]) / 2;
  if (farY >= nearY) {
    return "The far corners are not above the near ones — the court is marked upside down.";
  }
  const nearW = Math.abs(corners.bottomRight[0] - corners.bottomLeft[0]);
  const farW = Math.abs(corners.topRight[0] - corners.topLeft[0]);
  if (!(nearW > 0)) return "The two near corners are on top of each other.";
  if (farW > nearW * 1.05) {
    return "The far end of the court is marked wider than the near end, which no camera sees.";
  }
  if (farW < nearW * 0.15) {
    return "The far corners are almost on the same spot — they look like they were placed on the horizon rather than on the baseline.";
  }
  return null;
}
