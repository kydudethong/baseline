import { transformToCourtCoordinates } from "./court";
import { courtFrameFor } from "./shots";
import type { CourtCalibration, PlayerMovementMetrics, PlayerTrack, MovementSample } from "./phase2-types";

// Physical size of one court unit on each axis comes from what the
// detector said the quad is (calibration.quadKind — see shots.ts
// courtFrameFor()): 20 ft wide always; 15, 22 or 44 ft deep. Metres
// figures are still labelled "approx" downstream: the quad corners are a
// contour fit, not surveyed points.

export function analyzeMovement(
  track: PlayerTrack,
  calibration: CourtCalibration,
  frameWidthPx: number,
  frameHeightPx: number
): PlayerMovementMetrics {
  const totalSampleCount = track.points.length;

  const samples: MovementSample[] = [];
  let transformedCount = 0;
  let prev: { t: number; x: number; y: number } | null = null;
  let distanceCourtUnits = 0;
  let maxSpeed = 0;
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;

  for (const point of track.points) {
    const court = transformToCourtCoordinates(point.boxImageNorm, calibration, frameWidthPx, frameHeightPx);
    if (!court) continue;
    transformedCount += 1;

    let speed: number | null = null;
    if (prev) {
      const dt = point.timestampSeconds - prev.t;
      const dx = court.x - prev.x;
      const dy = court.y - prev.y;
      const dist = Math.hypot(dx, dy);
      distanceCourtUnits += dist;
      if (dt > 0) {
        speed = dist / dt;
        maxSpeed = Math.max(maxSpeed, speed);
      }
    }

    xMin = Math.min(xMin, court.x);
    xMax = Math.max(xMax, court.x);
    yMin = Math.min(yMin, court.y);
    yMax = Math.max(yMax, court.y);

    samples.push({
      timestampSeconds: point.timestampSeconds,
      courtX: court.x,
      courtY: court.y,
      speedCourtUnitsPerSecond: speed,
    });

    prev = { t: point.timestampSeconds, x: court.x, y: court.y };
  }

  if (transformedCount === 0) {
    return {
      playerId: track.playerId,
      distanceCoveredCourtUnits: null,
      distanceCoveredMetersApprox: null,
      averageSpeedCourtUnitsPerSecond: null,
      maxSpeedCourtUnitsPerSecond: null,
      courtCoverageBounds: null,
      samples: [],
      transformedSampleCount: 0,
      totalSampleCount,
    };
  }

  const durationSeconds = samples[samples.length - 1].timestampSeconds - samples[0].timestampSeconds;
  const avgSpeed = durationSeconds > 0 ? distanceCourtUnits / durationSeconds : null;

  // Court units aren't square (x-axis ~6.10m over unit 1, y-axis ~6.71m over
  // unit 1), so a straight "distance * meters-per-unit" would be wrong for
  // diagonal movement. Approximate by scaling each axis independently
  // before combining — still an approximation, not exact geodesic distance
  // on the real court, and labeled as such downstream.
  const frame = courtFrameFor(calibration.quadKind);
  let distanceMeters = 0;
  prev = null;
  for (const s of samples) {
    if (prev) {
      const dx = (s.courtX - prev.x) * frame.metresX;
      const dy = (s.courtY - prev.y) * frame.metresY;
      distanceMeters += Math.hypot(dx, dy);
    }
    prev = { t: s.timestampSeconds, x: s.courtX, y: s.courtY };
  }

  return {
    playerId: track.playerId,
    distanceCoveredCourtUnits: Math.round(distanceCourtUnits * 1000) / 1000,
    distanceCoveredMetersApprox: Math.round(distanceMeters * 100) / 100,
    averageSpeedCourtUnitsPerSecond: avgSpeed !== null ? Math.round(avgSpeed * 1000) / 1000 : null,
    maxSpeedCourtUnitsPerSecond: Math.round(maxSpeed * 1000) / 1000,
    courtCoverageBounds: { xMin, xMax, yMin, yMax },
    samples,
    transformedSampleCount: transformedCount,
    totalSampleCount,
  };
}
