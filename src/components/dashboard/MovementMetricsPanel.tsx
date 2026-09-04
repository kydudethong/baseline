import type { CourtCalibrationRow, MovementMetricRow } from "@/lib/db/types";
import { colorForPlayer, playerDisplayName } from "@/lib/vision/player-colors";

/**
 * Phase 2 movement section — data comes from dedicated tables
 * (court_calibrations/movement_metrics), not the analyses.result blob.
 * Every number here traces back to a real measurement or is null — never
 * a placeholder zero — see movement.ts.
 *
 * What a player sees vs. what we store: distance is shown in feet and
 * meters (the meters figure is already an approximation, see
 * ASSUMED_COURT_* in movement.ts); court coverage comes from the stored
 * coverage bounds; the "court units / second" speed columns stay in the
 * database and the debug page only — a unit nobody plays in is worse
 * than no number.
 */
export function MovementMetricsPanel({
  calibration,
  movement,
  selfLabels,
}: {
  calibration: CourtCalibrationRow | null;
  movement: MovementMetricRow[];
  /** Track labels the user tagged as themselves — those cards lead. */
  selfLabels: string[];
}) {
  if (!calibration && movement.length === 0) return null;

  const calibrated = Boolean(calibration && calibration.confidence > 0);
  const self = new Set(selfLabels);
  const ordered = [...movement].sort((a, b) => Number(self.has(b.player_label)) - Number(self.has(a.player_label)));
  const colorIndex = new Map(movement.map((m, i) => [m.player_label, i]));

  return (
    <section className="sec">
      <div className="stack g1">
        <h3 className="eyebrow">Player movement</h3>
        <p className="sm measure">
          {calibrated
            ? "Estimated from where each player's feet land on the detected court. Treat distances as ballpark, not GPS."
            : "Baseline couldn't lock onto the court lines in this clip, so distances aren't available — a fixed camera with the whole court in frame fixes this."}
        </p>
      </div>

      {movement.length > 0 ? (
        <div className="grid2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
          {ordered.map((m) => {
            const isSelf = self.has(m.player_label);
            const color = colorForPlayer(m.player_label, colorIndex.get(m.player_label) ?? 0);
            const meters = m.distance_covered_meters_approx;
            const coverage = coverageOf(m.court_coverage_bounds);
            const tracked = m.total_sample_count > 0 ? Math.round((m.transformed_sample_count / m.total_sample_count) * 100) : 0;
            return (
              <div key={m.player_label} className="card stack g4" style={isSelf ? { borderColor: color } : undefined}>
                <div className="row g2">
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: color, flex: "none" }} />
                  <span className="h3">{playerDisplayName(m.player_label)}</span>
                  {isSelf ? <span className="pill p-good mla">You</span> : null}
                </div>
                <div className="figs" style={{ gridTemplateColumns: "1fr 1fr", gap: "var(--a4)" }}>
                  <div className="fig">
                    <span className="v">
                      {meters !== null ? (
                        <>
                          {Math.round(meters * 3.281)}
                          <span className="u">ft</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </span>
                    <span className="c">
                      Distance covered{meters !== null ? ` · ${Math.round(meters)} m` : ""}
                    </span>
                  </div>
                  <div className="fig">
                    <span className="v">
                      {coverage ? (
                        <>
                          {coverage.width}
                          <span className="u">%</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </span>
                    <span className="c">
                      Court width covered{coverage ? ` · ${coverage.depth}% of depth` : ""}
                    </span>
                  </div>
                </div>
                <p className="xs">Tracked on court for {tracked}% of the clip.</p>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function coverageOf(bounds: unknown): { width: number; depth: number } | null {
  if (!bounds || typeof bounds !== "object") return null;
  const b = bounds as Partial<Record<"xMin" | "xMax" | "yMin" | "yMax", number>>;
  if ([b.xMin, b.xMax, b.yMin, b.yMax].some((v) => typeof v !== "number" || !Number.isFinite(v))) return null;
  const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v * 100)));
  return { width: clamp(b.xMax! - b.xMin!), depth: clamp(b.yMax! - b.yMin!) };
}
