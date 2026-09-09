/**
 * How alike two cameras are, from the court quad alone.
 *
 * This exists because of one fact that decides whether the whole reference
 * library is useful or actively misleading: a joint angle measured in 2D is a
 * projection, not a property of the body. The same elbow, at the same real
 * angle, projects to different 2D angles from a low baseline camera and from
 * an elevated broadcast camera. Comparing those two numbers produces a precise,
 * confident figure that means nothing.
 *
 * Court-space and timing metrics are immune -- both sides map onto the same
 * 20x44 ft court, or onto the same clock. Pose-derived metrics are not, and
 * they must only ever be compared between clips shot from similar geometry.
 * This module produces the number that gate is made of.
 *
 * Two things are compared, both readable straight off the court quad:
 *
 *   Foreshortening  How much the far baseline is compressed relative to the
 *                   near one. Almost entirely a function of camera height and
 *                   distance behind the court, which is exactly what changes
 *                   the projection of a limb.
 *   Yaw             How far off-centre the camera is, from the asymmetry
 *                   between the two sidelines. A side-on camera sees a swing
 *                   in a plane a behind-the-baseline camera cannot.
 */

export interface CourtQuadPx {
  /** Clockwise from the corner nearest the camera on the left. */
  nearLeft: [number, number];
  nearRight: [number, number];
  farRight: [number, number];
  farLeft: [number, number];
}

export interface CameraGeometry {
  /** far baseline width / near baseline width, in pixels. Lower = lower camera. */
  foreshortening: number;
  /** 0 = dead centre behind the baseline, 1 = fully side-on. */
  yaw: number;
}

const dist = (a: [number, number], b: [number, number]) => Math.hypot(b[0] - a[0], b[1] - a[1]);

export function cameraGeometry(q: CourtQuadPx): CameraGeometry | null {
  const near = dist(q.nearLeft, q.nearRight);
  const far = dist(q.farLeft, q.farRight);
  if (!(near > 0) || !(far > 0) || !Number.isFinite(near) || !Number.isFinite(far)) return null;

  const foreshortening = Math.min(1, far / near);

  // Sideline lengths differ when the camera is off to one side. Normalised by
  // their mean so it is a shape property, not a zoom property.
  const left = dist(q.nearLeft, q.farLeft);
  const right = dist(q.nearRight, q.farRight);
  const mean = (left + right) / 2;
  const yaw = mean > 0 ? Math.min(1, Math.abs(left - right) / mean) : 1;

  return { foreshortening, yaw };
}

/**
 * 1 when two clips were shot from effectively the same kind of position,
 * falling away as either the height or the angle diverges.
 *
 * The tolerances are deliberately tight for foreshortening. It is the term
 * that tracks camera height, and camera height is what decides whether a
 * player's limbs are seen along their length or across it -- a 2x difference
 * there makes knee-bend numbers incomparable even though both clips look like
 * "a pickleball court from behind".
 */
export function cameraSimilarity(a: CameraGeometry | null, b: CameraGeometry | null): number {
  if (!a || !b) return 0;
  const fRatio = Math.min(a.foreshortening, b.foreshortening) / Math.max(a.foreshortening, b.foreshortening);
  const fScore = Math.max(0, (fRatio - 0.5) / 0.5);          // 1 at identical, 0 at 2x apart
  const yScore = Math.max(0, 1 - Math.abs(a.yaw - b.yaw) / 0.35);
  return Math.round(Math.min(fScore, yScore) * 100) / 100;    // the weaker term rules
}

/**
 * Whether a metric may be compared across these two cameras at all.
 *
 * Court-space and timing metrics always may. Pose metrics may only when the
 * geometry is close, and "close" is strict on purpose: the cost of a wrong
 * comparison here is a coaching instruction to change something that was never
 * measured, which is worse than saying nothing.
 */
export function metricIsComparable(metric: string, similarity: number): boolean {
  return POSE_DEPENDENT.has(metric) ? similarity >= 0.6 : true;
}

/** Metrics whose value depends on where the camera stood. */
export const POSE_DEPENDENT = new Set([
  "knee_bend_deg_at_contact",
  "paddle_height_ratio",
  "shoulder_rotation_deg",
  "contact_height_ratio",
  "trunk_lean_deg",
]);
