import { detectCourtViaPython } from "./cv-scripts";
import { computeHomography, applyHomography, type Homography } from "./homography";
import type { BoundingBoxNorm, CourtCalibration } from "./phase2-types";

export async function detectCourt(frame: { path: string; timestampSeconds: number }): Promise<CourtCalibration> {
  const raw = await detectCourtViaPython(frame.path);
  return {
    method: "classical-cv-hsv-contour",
    confidence: raw.confidence,
    cornersImagePx: raw.cornersImagePx,
    frameTimestampSeconds: frame.timestampSeconds,
    diagnostics: raw.diagnostics,
  };
}

const homographyCache = new WeakMap<CourtCalibration, Homography | null>();

function getHomography(calibration: CourtCalibration): Homography | null {
  if (homographyCache.has(calibration)) return homographyCache.get(calibration) ?? null;

  let h: Homography | null = null;
  if (calibration.cornersImagePx && calibration.confidence > 0) {
    const c = calibration.cornersImagePx;
    // Court-unit square: (0,0) near-left baseline corner .. (1,1) far-right
    // corner of the calibrated quadrilateral. This is a UNIT of the
    // detected quad, not the full physical court — see analyzeMovement()
    // for how that's converted to an approximate meters figure.
    h = computeHomography(
      [c.topLeft, c.topRight, c.bottomLeft, c.bottomRight],
      [[0, 0], [1, 0], [0, 1], [1, 1]]
    );
  }
  homographyCache.set(calibration, h);
  return h;
}

/**
 * Maps a normalized image-space box (its bottom-center point — the
 * player's feet, the only part of a bounding box that's actually ON the
 * court plane; using the box center would put "position" somewhere around
 * the player's waist, floating above the court) into court coordinates.
 * Returns null (not a guessed value) whenever calibration is missing/failed
 * or the point falls outside a numerically stable region of the transform.
 */
export function transformToCourtCoordinates(
  boxImageNorm: BoundingBoxNorm,
  calibration: CourtCalibration,
  frameWidthPx: number,
  frameHeightPx: number
): { x: number; y: number } | null {
  const h = getHomography(calibration);
  if (!h) return null;

  const feetXNorm = boxImageNorm.x + boxImageNorm.width / 2;
  const feetYNorm = boxImageNorm.y + boxImageNorm.height;
  const feetXPx = feetXNorm * frameWidthPx;
  const feetYPx = feetYNorm * frameHeightPx;

  const [cx, cy] = applyHomography(h, [feetXPx, feetYPx]);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  return { x: cx, y: cy };
}
