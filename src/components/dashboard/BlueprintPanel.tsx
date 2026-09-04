import type { CoachingBlueprintRow, CoachingBlueprintStepRow } from "@/lib/db/types";
import { skillName } from "@/lib/coaching/types";
import { StepToggle } from "@/components/breakdown/StepToggle";

export function BlueprintPanel({
  analysisId,
  blueprint,
  steps,
}: {
  analysisId: string;
  blueprint: CoachingBlueprintRow;
  steps: CoachingBlueprintStepRow[];
}) {
  const doneCount = steps.filter((s) => s.done_at).length;
  const nextStep = steps.filter((s) => !s.done_at)[0];

  return (
    <div className="card stack g3">
      <div className="row g3">
        <p className="h3">{blueprint.title}</p>
        <span className="pill p-neutral mla">{skillName(blueprint.skill_key)}</span>
        <span className="pill p-warn">
          <span className="dot" />
          {doneCount} of {steps.length} done
        </span>
      </div>
      <p className="sm">{blueprint.goal}</p>
      <p className="xs">
        <strong style={{ color: "var(--ink)" }}>Target:</strong> {blueprint.target}
      </p>

      <div className="bp">
        {steps.map((s) => {
          const done = Boolean(s.done_at);
          const isNext = !done && nextStep?.id === s.id;
          return (
            <div key={s.id} className={`bp-step${done ? " done" : ""}${isNext ? " next" : ""}`}>
              <StepToggle analysisId={analysisId} stepId={s.id} done={done} idx={s.idx} />
              <div className="bp-body">
                <span className="focus">{s.focus}</span>
                <span className="dn">{s.drill_name}</span>
                <span className="sm">{s.target}</span>
              </div>
            </div>
          );
        })}
      </div>
      <p className="note">
        The order is the point — each session builds on the one before it.
      </p>
    </div>
  );
}
