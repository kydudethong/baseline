import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getAllDrills } from "@/lib/coaching/drills";
import { SKILLS } from "@/lib/coaching/types";
import type { CoachingDrillRow } from "@/lib/db/types";

export const metadata: Metadata = { title: "Drills — Baseline" };
export const dynamic = "force-dynamic";

const GROUP_ORDER = ["Kitchen", "Movement", "Serve & return", "Offense", "Decisions", "Defense"];

function skillName(key: string): string {
  return SKILLS.find((s) => s.key === key)?.name ?? key;
}
function skillGroup(key: string): string {
  return SKILLS.find((s) => s.key === key)?.group ?? "Other";
}

export default async function DrillsPage() {
  const supabase = await createClient();
  const drills = await getAllDrills(supabase);

  const byGroup = GROUP_ORDER.map((group) => ({
    group,
    drills: drills.filter((d) => skillGroup(d.skill_key) === group),
  })).filter((g) => g.drills.length > 0);

  return (
    <div className="sec">
      <div className="stack g1">
        <span className="eyebrow">Drills</span>
        <h1 className="h1">The full drill library</h1>
        <p className="sm measure">
          {drills.length} drills you can run without a coach standing next to you. A weakness on your Practice page
          links here for the ones matched to it — this is the whole library, browsable on its own.
        </p>
      </div>

      {byGroup.map(({ group, drills: groupDrills }) => (
        <div key={group} className="sec">
          <div className="sec-head">
            <h2 className="h2">{group}</h2>
            <span className="xs">{groupDrills.length}</span>
          </div>
          <div className="grid2">
            {groupDrills.map((drill) => (
              <DrillCard key={drill.slug} drill={drill} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function DrillCard({ drill }: { drill: CoachingDrillRow }) {
  const steps = Array.isArray(drill.steps) ? (drill.steps as string[]) : [];
  const mistakes = Array.isArray(drill.mistakes) ? (drill.mistakes as string[]) : [];

  return (
    <div className="card stack g3">
      <div className="stack g1">
        <div className="row g2" style={{ justifyContent: "space-between" }}>
          <span className="eyebrow">{skillName(drill.skill_key)}</span>
          <span className="chip">{drill.difficulty}</span>
        </div>
        <p className="h3">{drill.name}</p>
        <p className="sm">{drill.purpose}</p>
      </div>

      <div className="row g4 xs">
        <span>
          {drill.players} player{drill.players === 1 ? "" : "s"}
        </span>
        <span>{drill.equipment}</span>
      </div>

      <details>
        <summary className="crumb" style={{ cursor: "pointer" }}>
          Steps &amp; common mistakes
        </summary>
        <div className="stack g3" style={{ marginTop: "var(--a3)" }}>
          <ol className="sm stack g1" style={{ paddingLeft: "1.1em" }}>
            {steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          {mistakes.length > 0 ? (
            <div className="note">
              <span className="eyebrow">Watch for</span>
              <ul className="sm stack g1" style={{ paddingLeft: "1.1em", marginTop: "6px" }}>
                {mistakes.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
}
