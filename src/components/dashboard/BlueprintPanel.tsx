import type { CoachingBlueprintRow, CoachingBlueprintStepRow } from "@/lib/db/types";
import { skillName } from "@/lib/coaching/types";

export function BlueprintPanel({
  blueprint,
  steps,
}: {
  blueprint: CoachingBlueprintRow;
  steps: CoachingBlueprintStepRow[];
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-slate-900">{blueprint.title}</p>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
          {skillName(blueprint.skill_key)}
        </span>
      </div>
      <p className="mt-1 text-sm text-slate-700">{blueprint.goal}</p>
      <p className="mt-1 text-xs text-slate-500">Target: {blueprint.target}</p>

      <ol className="mt-3 space-y-2">
        {steps.map((s) => (
          <li key={s.id} className="flex items-start gap-3 rounded-lg border border-slate-100 bg-slate-50 p-2.5 text-sm">
            <span
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                s.done_at ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-600"
              }`}
            >
              {s.idx + 1}
            </span>
            <div>
              <p className="font-medium text-slate-900">
                {s.focus} — <span className="font-normal text-slate-700">{s.drill_name}</span>
              </p>
              <p className="text-xs text-slate-500">{s.target}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
