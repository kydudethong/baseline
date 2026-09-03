import type { CourtCalibrationRow, MovementMetricRow } from "@/lib/db/types";

/**
 * Phase 2 movement section — separate from AnalysisResultPanel because this
 * data comes from dedicated tables (court_calibrations/movement_metrics),
 * not the analyses.result jsonb blob, and is richer than what's summarized
 * there. Every number here traces back to a real measurement or is null —
 * never a placeholder zero — see movement.ts.
 */
export function MovementMetricsPanel({
  calibration,
  movement,
}: {
  calibration: CourtCalibrationRow | null;
  movement: MovementMetricRow[];
}) {
  if (!calibration && movement.length === 0) return null;

  const calibrated = calibration && calibration.confidence > 0;

  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Player movement (measured)
      </h3>

      {calibration ? (
        <div
          className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
            calibrated ? "border-slate-200 bg-white text-slate-700" : "border-amber-200 bg-amber-50 text-amber-900"
          }`}
        >
          Court calibration confidence: <strong>{calibration.confidence}</strong> ({calibration.method}).{" "}
          {calibrated
            ? "Distance/speed below are approximate, derived from mapping each player's feet into this calibration — see the debug page to see the detected court outline."
            : "Calibration failed for this clip, so distance/speed are null for every player rather than guessed."}
        </div>
      ) : null}

      {movement.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="px-4 py-2">Player</th>
                <th className="px-4 py-2">Distance (approx)</th>
                <th className="px-4 py-2">Avg speed</th>
                <th className="px-4 py-2">Max speed</th>
                <th className="px-4 py-2">Tracked points</th>
              </tr>
            </thead>
            <tbody>
              {movement.map((m) => (
                <tr key={m.player_label} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2 font-medium text-slate-900">{m.player_label}</td>
                  <td className="px-4 py-2">
                    {m.distance_covered_meters_approx !== null ? `${m.distance_covered_meters_approx} m` : "—"}
                  </td>
                  <td className="px-4 py-2">
                    {m.average_speed_court_units_s !== null ? `${m.average_speed_court_units_s} units/s` : "—"}
                  </td>
                  <td className="px-4 py-2">
                    {m.max_speed_court_units_s !== null ? `${m.max_speed_court_units_s} units/s` : "—"}
                  </td>
                  <td className="px-4 py-2 text-slate-500">
                    {m.transformed_sample_count}/{m.total_sample_count}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
