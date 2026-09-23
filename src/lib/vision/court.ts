import { detectCourtViaPython } from "./cv-scripts";
import { courtQuadProblem } from "./court-quad";
import { computeHomography, applyHomography, type Homography } from "./homography";
import { courtFrameFor } from "./shots";
import type { PreAnalysisSetup } from "@/lib/db/setup";
import type { BoundingBoxNorm, CourtCalibration } from "./phase2-types";

/**
 * The court as the user marked it during setup.
 *
 * Confidence 1.0, and that is not flattery. Every other value in this field is
 * a detector's opinion about whether it found the paint; this one is a person
 * who looked at the frame and clicked on it. Nothing automatic should ever
 * outrank it, and the only way to express that here is to top out the number
 * the rest of the pipeline sorts on.
 *
 * Coordinates were clicked on the frame the setup page rendered, which is the
 * video at its own resolution unless the browser scaled it, so they are
 * rescaled rather than assumed to match.
 */
/**
 * Is this quad geometrically capable of being the court in this frame?
 *
 * A confidence number says how well a detector thinks it did; it says nothing
 * about whether the answer is possible. This app's contour detector returns a
 * 63px-tall sliver pinned to the bottom edge -- 0.22% of the frame, labelled a
 * FULL 44ft court -- and reports 0.777 for it. Nothing downstream questioned
 * that, so it flowed into the court gate, the side-of-net test, movement
 * distances and shot classification, where it silently disabled the first two
 * (the homography rejects most points, and a null court position is treated as
 * "keep everyone") and made the last two wrong but confident-looking.
 *
 * The same test already existed, correctly, in rally-seg.ts -- but only to
 * decide what to hand to rally_seg, never to decide what this pipeline itself
 * would trust.
 */
export function isPlausibleCourtQuad(
  cal: CourtCalibration | null,
  frameWidthPx: number,
  frameHeightPx: number
): boolean {
  return courtQuadProblem(
    cal?.cornersImagePx ?? null,
    frameWidthPx,
    frameHeightPx,
    cal?.quadKind ?? "full",
  ) === null;
}

/**
 * The ground region, in image pixels, where a player on THIS court can stand.
 *
 * Built entirely in image space, from the court quad itself. The obvious
 * alternative -- map the player's feet into court coordinates and test the
 * range -- is what this replaces, and it fails in exactly the place that
 * matters. A low camera behind the baseline compresses the far half of the
 * court into a few dozen pixels, so mapping a point near the far end is
 * extrapolation toward the vanishing line: small pixel errors become huge
 * court-coordinate errors, and a player two courts away can land inside a
 * generous x range while a real player near the camera lands outside it.
 *
 * Widening happens along each edge's OWN direction, not by a fixed number of
 * pixels. That is what makes it work on neighbouring courts: the far baseline
 * is a few hundred pixels wide in the image, so a 15% margin there is tens of
 * pixels, while the same 15% at the near baseline is hundreds. The tolerance
 * shrinks with distance exactly as the court does.
 *
 * The near edge is pushed well past the bottom of the frame, because a player
 * close to the camera has their feet at or below the picture edge -- testing
 * against the near baseline is what "it loses players near the camera" means.
 */
export function playerGatePolygonPx(
  cal: CourtCalibration | null,
  frameHeightPx: number,
  marginFrac = 0.15
): Array<[number, number]> | null {
  const c = cal?.cornersImagePx;
  if (!c || cal!.confidence <= 0) return null;
  const pts: Array<[number, number]> = [c.bottomLeft, c.bottomRight, c.topRight, c.topLeft];
  if (pts.some((p) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) return null;

  const [nl0, nr0, fr0, fl0] = pts;
  const widen = (a: [number, number], b: [number, number], f: number): [[number, number], [number, number]] => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    return [[a[0] - dx * f, a[1] - dy * f], [b[0] + dx * f, b[1] + dy * f]];
  };
  const [nl, nr] = widen(nl0, nr0, marginFrac);
  const [fl, fr] = widen(fl0, fr0, marginFrac);

  // Follow each sideline's own direction down past the frame edge, rather than
  // dropping straight down — the sidelines still bound the court sideways.
  const bottom = frameHeightPx * 1.6;
  const extendDown = (near: [number, number], far: [number, number]): [number, number] => {
    const dy = near[1] - far[1];
    if (Math.abs(dy) < 1e-6) return [near[0], bottom];
    const t = (bottom - far[1]) / dy;
    return [far[0] + (near[0] - far[0]) * t, bottom];
  };

  // Run-off behind the far baseline gets its own two vertices rather than
  // being folded into the sideline ones. Moving the sideline's endpoint up
  // while holding its x fixed does not extend the sideline -- it tilts it, and
  // the polygon then bulges outward across the whole far half, which is
  // exactly where it must be tightest.
  const back = (near: [number, number], far: [number, number]): [number, number] => {
    const dy = near[1] - far[1];
    if (Math.abs(dy) < 1e-6) return far;
    const t = -marginFrac; // a fraction of court depth PAST the far baseline
    return [far[0] + (near[0] - far[0]) * t, far[1] + dy * t];
  };

  return [
    extendDown(nl, fl), extendDown(nr, fr),  // near edge, past the frame bottom
    fr, back(nr, fr), back(nl, fl), fl,      // far edge, with run-off behind it
  ];
}

/**
 * Image region where a ball belonging to THIS court can be — including its air.
 *
 * Different shape from the player gate, and deliberately so. A player is on
 * the ground, so their region is the court surface. A ball spends most of a
 * rally above it, and the airspace over a court is not the court: it is a
 * column standing on it.
 *
 * The far end is therefore extended STRAIGHT UP to the top of the frame rather
 * than following the sidelines toward the vanishing point. A lob is high in
 * the image but barely moves horizontally, so letting the sides converge
 * upward would throw away exactly the shots that go highest -- the airspace
 * above the far court has to stay as wide as the far baseline.
 *
 * This is what stops a ball on the next court being tracked as yours. Without
 * it the tracker will happily follow a neighbouring rally, and every boundary
 * downstream is then measuring somebody else's game.
 */
export function ballGatePolygonPx(
  cal: CourtCalibration | null,
  frameHeightPx: number,
  marginFrac = 0.12,
  skyPx = 40,   // how far ABOVE the frame the column extends
  floorPx = 80
): Array<[number, number]> | null {
  const c = cal?.cornersImagePx;
  if (!c || cal!.confidence <= 0) return null;
  const pts: Array<[number, number]> = [c.bottomLeft, c.bottomRight, c.topRight, c.topLeft];
  if (pts.some((p) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) return null;

  const [nl0, nr0, fr0, fl0] = pts;
  const widen = (a: [number, number], b: [number, number], f: number): [[number, number], [number, number]] => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    return [[a[0] - dx * f, a[1] - dy * f], [b[0] + dx * f, b[1] + dy * f]];
  };
  const [nl, nr] = widen(nl0, nr0, marginFrac);
  const [fl, fr] = widen(fl0, fr0, marginFrac);

  // All the way past the top of the frame. `skyPx` above the far baseline is
  // not "the airspace above the court", it is a 40-pixel strip -- measured on
  // a real clip that rejected two thirds of the ball's own observations,
  // including every lob, because a lob leaves that strip immediately.
  const top = -skyPx;
  return [
    [nl[0], nl[1] + floorPx],
    [nr[0], nr[1] + floorPx],
    [fr[0], fr[1]],
    [fr[0], top],      // straight up, not converging
    [fl[0], top],
    [fl[0], fl[1]],
  ];
}

/**
 * How much the court is foreshortened at an image row, relative to the near
 * baseline. 1.0 at the near baseline, falling toward 0 at the far one.
 *
 * Why this exists: every speed threshold in the hit detector is expressed in
 * normalized IMAGE units per second, and the image is a projection. The same
 * physical ball speed produces fewer pixels per second the further up the
 * frame it is, so one constant threshold is really a near-court threshold
 * being applied to the whole court. Measured on ky-720p: the median candidate
 * moved 0.375 image-units/s in the bottom band of the frame but 0.156 in the
 * middle band, and the fixed 0.35 cutoff rejected 44% of near-court
 * candidates against 79% of the ones further away. That is not the far court
 * playing more slowly; it is the projection.
 *
 * Multiplying a threshold by this ratio makes it mean the same physical speed
 * everywhere, and — because the ratio is 1 at the near baseline — leaves
 * near-court behaviour exactly as it was tuned.
 *
 * Sidelines are straight lines in the image (perspective maps lines to
 * lines), so interpolating each one at the row is exact. The ball itself is
 * usually ABOVE the court plane, which makes it appear higher up the frame
 * than its ground position and so slightly over-corrects. That errs toward
 * accepting a contact, which is the safer direction here; `t` is clamped to
 * the quad so a lob above the far baseline cannot drive the threshold to
 * zero.
 */
export function courtForeshorteningAt(
  cal: CourtCalibration | null,
  yPx: number
): number | null {
  const c = cal?.cornersImagePx;
  if (!c || !cal || cal.confidence <= 0) return null;
  const pts = [c.bottomLeft, c.bottomRight, c.topLeft, c.topRight];
  if (pts.some((q) => !Array.isArray(q) || q.length !== 2 || !q.every(Number.isFinite))) return null;
  const [nl, nr, fl, fr] = pts as Array<[number, number]>;

  const nearWidth = Math.abs(nr[0] - nl[0]);
  if (!(nearWidth > 1e-6)) return null;

  const xAt = (near: [number, number], far: [number, number]): number => {
    const dy = far[1] - near[1];
    if (Math.abs(dy) < 1e-6) return near[0];
    const t = Math.min(1, Math.max(0, (yPx - near[1]) / dy));
    return near[0] + (far[0] - near[0]) * t;
  };

  const width = Math.abs(xAt(nr, fr) - xAt(nl, fl));
  const ratio = width / nearWidth;
  if (!Number.isFinite(ratio)) return null;
  return Math.min(1, Math.max(0.15, ratio));
}

/** Standard ray-casting point-in-polygon. */
export function pointInPolygon(pt: [number, number], poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1])
        && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function calibrationFromSetup(
  setup: PreAnalysisSetup | null,
  frameWidthPx: number,
  frameHeightPx: number
): CourtCalibration | null {
  const c = setup?.court;
  if (!c || !setup) return null;
  const sx = setup.frameWidthPx > 0 ? frameWidthPx / setup.frameWidthPx : 1;
  const sy = setup.frameHeightPx > 0 ? frameHeightPx / setup.frameHeightPx : 1;
  const at = (p: { x: number; y: number }): [number, number] => [p.x * sx, p.y * sy];
  const pts = [c.nearLeft, c.nearRight, c.farRight, c.farLeft];
  if (pts.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;

  return {
    method: "manual",
    confidence: 1,
    cornersImagePx: {
      bottomLeft: at(c.nearLeft),
      bottomRight: at(c.nearRight),
      topRight: at(c.farRight),
      topLeft: at(c.farLeft),
    },
    quadKind: c.quadKind,
    frameTimestampSeconds: setup.frameTimestampSeconds,
    diagnostics: { source: "pre-analysis-setup", quadKind: c.quadKind, markedAt: setup.savedAt },
  };
}

export async function detectCourt(frame: { path: string; timestampSeconds: number }): Promise<CourtCalibration> {
  const raw = await detectCourtViaPython(frame.path);
  return {
    method: "classical-cv-hsv-contour",
    confidence: raw.confidence,
    cornersImagePx: raw.cornersImagePx,
    quadKind: raw.quadKind ?? null,
    frameTimestampSeconds: frame.timestampSeconds,
    // quadKind rides along in diagnostics too, so it survives the DB round
    // trip without a schema change (court_calibrations.diagnostics is jsonb).
    diagnostics: { ...raw.diagnostics, quadKind: raw.quadKind ?? null },
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

  // Same numerically-soft-region guard shots.ts's toCourt() applies to
  // shot-landing points: a planar homography is only trustworthy near the
  // calibrated quad. A player standing well past the far baseline is far
  // enough from the camera that a few pixels of ordinary detection jitter
  // become feet (sometimes meters) of "movement" once translated through
  // the perspective transform -- found via real tracking data where a
  // few-pixel box wobble on a far-court player produced implied speeds of
  // 15-30 m/s (unrunnable for a human). Reject those points outright
  // rather than feeding fake motion into anything downstream (rally
  // boundaries, distance-covered stats): a missing sample is honest, a
  // fabricated one isn't.
  const frame = courtFrameFor(calibration.quadKind);
  const farBaselineY = frame.netY - frame.halfLength;
  const nearBaselineY = frame.netY + frame.halfLength;
  const maxY = nearBaselineY + 0.25 * frame.halfLength;
  const minY = farBaselineY - 1.5 * frame.halfLength;
  if (cx < -0.6 || cx > 1.6 || cy < minY || cy > maxY) return null;

  return { x: cx, y: cy };
}
