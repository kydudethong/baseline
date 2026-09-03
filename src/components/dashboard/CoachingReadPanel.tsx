import type { CoachingObservationRow, CoachingReadRow, CoachingSkillRatingRow } from "@/lib/db/types";
import { COACHING_DIMENSION_LABELS, skillName, type CoachingDimension, type CoachingRead } from "@/lib/coaching/types";
import { BuildBlueprintButton } from "./BuildBlueprintButton";

/**
 * Renders one coaching_reads row plus its tagged observations and skill
 * ratings. Deliberately shows only what run-coaching.ts actually persisted
 * — coaching_json is null on the "not enough data" path (see its comment
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
    <section className="space-y-6">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-slate-900">{read.headline ?? "Coaching read"}</h2>
          {read.model ? (
            <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-500">
              {read.model}
            </span>
          ) : null}
        </div>
        {read.summary ? <p className="mt-2 text-sm text-slate-700">{read.summary}</p> : null}
      </div>

      {quality && !quality.usable ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong className="font-semibold">Limited footage quality.</strong>
          {quality.issues.length > 0 ? (
            <ul className="mt-1 list-inside list-disc space-y-0.5">
              {quality.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {coaching ? (
        <div className="space-y-6">
          {coaching.strengths.length > 0 ? (
            <SectionList title="Strengths" items={coaching.strengths} accent="emerald" />
          ) : null}

          <section>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Top priority fix
            </h3>
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4">
              <p className="font-semibold text-slate-900">{coaching.top_priority_fix.issue}</p>
              <p className="mt-1 text-sm text-slate-700">{coaching.top_priority_fix.why_it_matters}</p>
              <p className="mt-2 text-xs text-slate-500">Evidence: {coaching.top_priority_fix.evidence}</p>
            </div>
          </section>

          {coaching.secondary_observations.length > 0 ? (
            <section>
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
                Also worth noting
              </h3>
              <ul className="space-y-2">
                {coaching.secondary_observations.map((o, i) => (
                  <li key={i} className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
                    <p className="font-medium text-slate-900">{o.issue}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{o.evidence}</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Drill recommendation
            </h3>
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="font-semibold text-slate-900">{coaching.drill_recommendation.name}</p>
              <p className="mt-1 text-sm text-slate-700">Targets: {coaching.drill_recommendation.target}</p>
              <p className="mt-1 text-xs text-slate-500">{coaching.drill_recommendation.reps_duration}</p>
            </div>
          </section>

          {coaching.data_gaps ? (
            <p className="text-xs italic text-slate-500">Data gaps: {coaching.data_gaps}</p>
          ) : null}
        </div>
      ) : null}

      {skills.length > 0 ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Skill ratings
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {skills.map((s) => (
              <div key={s.id} className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-900">{skillName(s.skill_key)}</span>
                  <RatingDots value={s.raw} />
                </div>
                {s.basis ? <p className="mt-1 text-xs text-slate-500">{s.basis}</p> : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {observations.length > 0 ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Tagged observations
          </h3>
          <ul className="space-y-2">
            {observations.map((o) => (
              <li key={o.id} className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <ValenceBadge valence={o.valence} />
                  <span className="text-xs text-slate-500">
                    {COACHING_DIMENSION_LABELS[o.coaching_dimension as CoachingDimension] ?? o.coaching_dimension}
                  </span>
                  {o.rally_idx !== null ? (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">
                      rally {o.rally_idx}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1.5 font-medium text-slate-900">{o.title}</p>
                <p className="mt-0.5 text-slate-600">{o.detail}</p>
                {o.valence === "weakness" && !skillKeysWithBlueprint.has(o.skill_key) ? (
                  <BuildBlueprintButton analysisId={analysisId} observationId={o.id} />
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
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

function SectionList({ title, items, accent }: { title: string; items: string[]; accent: "emerald" }) {
  const dot = accent === "emerald" ? "bg-emerald-500" : "bg-slate-400";
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      <ul className="space-y-2">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700">
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ValenceBadge({ valence }: { valence: "strength" | "weakness" }) {
  const styles =
    valence === "strength" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${styles}`}>
      {valence === "strength" ? "Strength" : "Weakness"}
    </span>
  );
}

function RatingDots({ value }: { value: number }) {
  const clamped = Math.max(1, Math.min(5, Math.round(value)));
  return (
    <span className="flex items-center gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={`h-2 w-2 rounded-full ${i < clamped ? "bg-indigo-600" : "bg-slate-200"}`}
        />
      ))}
    </span>
  );
}
