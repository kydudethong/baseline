import type { CoachingObservationRow, CoachingReadRow, CoachingSkillRatingRow } from "@/lib/db/types";
import { COACHING_DIMENSION_LABELS, skillName, type CoachingDimension, type CoachingRead } from "@/lib/coaching/types";
import { SkillMeter } from "@/components/breakdown/SkillMeter";
import { BuildBlueprintButton } from "./BuildBlueprintButton";

/**
 * Renders one coaching_reads row plus its tagged observations and skill
 * ratings, in the coach app's original visual language (.weak/.pill/.card —
 * see globals.css) rather than the plain Tailwind cards this used before.
 * Deliberately shows only what run-coaching.ts actually persisted —
 * coaching_json is null on the "not enough data" path (see its comment
 * in run-coaching.ts), so this falls back to just the headline/summary/
 * quality section rather than rendering an empty strengths/fix/drill block.
 */
export function CoachingReadPanel({
  read,
  observations,
  skills,
  analysisId,
  skillKeysWithBlueprint,
}: {
  read: CoachingReadRow;
  observations: CoachingObservationRow[];
  skills: CoachingSkillRatingRow[];
  analysisId: string;
  /** skill_keys that already have a practice plan for this analysis — hide the build button rather than invite a duplicate. */
  skillKeysWithBlueprint: Set<string>;
}) {
  const coaching = parseCoaching(read.coaching_json);
  const quality = read.quality as { usable: boolean; issues: string[] } | null;

  return (
    <div className="stack g6">
      <div className="sec">
        <div className="row g3">
          <h2 className="d2 measure">{read.headline ?? "Coaching read"}</h2>
          {read.model ? <span className="pill p-neutral mono">{read.model}</span> : null}
        </div>
        {read.summary ? <p className="body measure">{read.summary}</p> : null}
      </div>

      {quality && !quality.usable ? (
        <div className="error">
          <strong>Limited footage quality.</strong>
          {quality.issues.length > 0 ? (
            <ul style={{ marginTop: 6, paddingLeft: 18, listStyle: "disc" }}>
              {quality.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {coaching ? (
        <>
          {coaching.strengths.length > 0 ? (
            <section className="sec">
              <h3 className="eyebrow">Strengths</h3>
              <div className="stack g3">
                {coaching.strengths.map((s, i) => (
                  <div key={i} className="card sm" style={{ borderLeft: "3px solid var(--good)" }}>
                    {s}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="sec">
            <h3 className="eyebrow">Top priority fix</h3>
            <div className="card" style={{ background: "var(--blue-wash)", boxShadow: "none" }}>
              <p className="h3">{coaching.top_priority_fix.issue}</p>
              <p className="sm" style={{ marginTop: 6 }}>{coaching.top_priority_fix.why_it_matters}</p>
              <p className="xs" style={{ marginTop: 8 }}>Evidence: {coaching.top_priority_fix.evidence}</p>
            </div>
          </section>

          {coaching.secondary_observations.length > 0 ? (
            <section className="sec">
              <h3 className="eyebrow">Also worth noting</h3>
              <div className="stack g2">
                {coaching.secondary_observations.map((o, i) => (
                  <div key={i} className="card" style={{ padding: "var(--a3) var(--a4)" }}>
                    <p className="sm" style={{ color: "var(--ink)", fontWeight: 600 }}>{o.issue}</p>
                    <p className="xs" style={{ marginTop: 2 }}>{o.evidence}</p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="sec">
            <h3 className="eyebrow">Drill recommendation</h3>
            <div className="card">
              <p className="h3">{coaching.drill_recommendation.name}</p>
              <p className="sm" style={{ marginTop: 4 }}>Targets: {coaching.drill_recommendation.target}</p>
              <p className="xs" style={{ marginTop: 4 }}>{coaching.drill_recommendation.reps_duration}</p>
            </div>
          </section>

          {coaching.data_gaps ? <p className="xs" style={{ fontStyle: "italic" }}>Data gaps: {coaching.data_gaps}</p> : null}
        </>
      ) : null}

      {skills.length > 0 ? (
        <section className="sec">
          <h3 className="eyebrow">Skill ratings</h3>
          <div className="grid2">
            {skills.map((s) => (
              <div key={s.id} className="card">
                <SkillMeter name={skillName(s.skill_key)} raw={s.raw} basis={s.basis} />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {observations.length > 0 ? (
        <section className="sec">
          <h3 className="eyebrow">Tagged observations</h3>
          <div className="stack g4">
            {observations.map((o) => (
              <div key={o.id} className={`weak${o.severity <= 3 ? " med" : ""}${o.valence === "strength" ? " strength" : ""}`}>
                <div className="stripe" />
                <div className="in">
                  <div className="row g3">
                    <span className="eyebrow">
                      {COACHING_DIMENSION_LABELS[o.coaching_dimension as CoachingDimension] ?? o.coaching_dimension}
                    </span>
                    {o.valence === "strength" ? (
                      <span className="pill p-good"><span className="dot" />Working</span>
                    ) : (
                      <span className="pill p-warn"><span className="dot" />Needs work</span>
                    )}
                    {o.rally_idx !== null ? <span className="pill p-neutral mono">Rally {o.rally_idx}</span> : null}
                  </div>
                  <h3 className="h2">{o.title}</h3>
                  <p className="body">{o.detail}</p>
                  <div className="evid">
                    {o.t_s !== null ? <a href={`#t=${Math.max(0, o.t_s).toFixed(1)}`}>watch {mmss(o.t_s)}</a> : null}
                    {o.valence === "weakness" && !skillKeysWithBlueprint.has(o.skill_key) ? (
                      <BuildBlueprintButton analysisId={analysisId} observationId={o.id} />
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function parseCoaching(json: string | null): CoachingRead | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as CoachingRead;
  } catch {
    // A malformed coaching_json shouldn't take the whole page down — show
    // just the headline/summary/quality section above instead.
    return null;
  }
}
