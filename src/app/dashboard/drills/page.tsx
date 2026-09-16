import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { getAllDrills } from "@/lib/coaching/drills";
import { SKILLS } from "@/lib/coaching/types";
import type { CoachingDrillRow } from "@/lib/db/types";
import { Paddle } from "@/components/motifs/Motifs";

export const metadata: Metadata = { title: "Drills — Baseline" };
export const dynamic = "force-dynamic";

// "Serve & return" is gone as a group: serve and third shot are Offense now,
// return is Defense. Decisions stays HERE even though it left the radar -- the
// drill library should still have somewhere to put shot selection and court
// IQ work, it just should not be an axis on a chart of measured play.
const GROUP_ORDER = ["Kitchen", "Movement", "Offense", "Defense", "Decisions"];

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
          {drills.length} drills you can run without a coach standing next to you. Your practice
          calendar picks from these automatically — this is the whole library, if you would rather
          browse.
        </p>
      </div>

      {byGroup.map(({ group, drills: groupDrills }) => (
        <div key={group} className="sec">
          <div className="sec-head">
            <h2 className="h2">{group}</h2>
            <span className="xs">{groupDrills.length}</span>
          </div>
          <div className="drill-grid">
            {groupDrills.map((drill) => (
              <DrillCard key={drill.slug} drill={drill} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * One drill, as a card you would actually stop and read.
 *
 * WHAT CHANGED AND WHY. Every card was the same weight — the skill, the
 * difficulty, the player count, the equipment and the name all rendered at
 * roughly the same visual priority, so a page of forty of them read as a wall
 * and the eye had nowhere to land. Browsing a library is a scanning task, and
 * scanning needs a clear first thing.
 *
 * So: the NAME leads, at size, with everything else demoted beneath it and the
 * purpose given room to be read. Difficulty carries a colour, because it is
 * the one attribute that decides whether a drill is for you today. The
 * requirements — how many people, what gear — are the practical gate on
 * whether you can do it at all, so they sit as small pills rather than a run
 * of grey text.
 *
 * The skill sits in a coloured strip down the left edge rather than as another
 * line of text: it groups the cards visually within a section without spending
 * a row on a fact the section heading already gave.
 */
function DrillCard({ drill }: { drill: CoachingDrillRow }) {
  const steps = Array.isArray(drill.steps) ? (drill.steps as string[]) : [];
  const mistakes = Array.isArray(drill.mistakes) ? (drill.mistakes as string[]) : [];
  const tone = difficultyTone(drill.difficulty);

  return (
    <article className={`drill-card d-${tone}`}>
      <header className="drill-card-head">
        <h3 className="drill-name">{drill.name}</h3>
        <span className={`pill p-${tone}`}>{drill.difficulty}</span>
      </header>

      <p className="drill-purpose">{drill.purpose}</p>

      <div className="drill-meta">
        <span className="drill-tag">
          <Paddle size={11} />
          {skillName(drill.skill_key)}
        </span>
        <span className="drill-tag">
          {drill.players === 1 ? "On your own" : `${drill.players} players`}
        </span>
        {drill.equipment ? <span className="drill-tag">{drill.equipment}</span> : null}
      </div>

      {steps.length > 0 || mistakes.length > 0 ? (
        <details className="drill-more">
          <summary>How to run it</summary>
          <div className="stack g3" style={{ marginTop: "var(--a3)" }}>
            {steps.length > 0 ? (
              <ol className="drill-steps">
                {steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            ) : null}
            {mistakes.length > 0 ? (
              <div className="drill-watch">
                <span className="eyebrow">Watch for</span>
                <ul>
                  {mistakes.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </article>
  );
}

/**
 * Difficulty to a colour token.
 *
 * Green for beginner and amber for advanced rather than the other way round:
 * the colour answers "can I do this today", where green means yes. Treating
 * advanced as the good end would invert that for the reader who most needs the
 * signal — somebody new, browsing forty drills.
 */
function difficultyTone(difficulty: string): "good" | "warn" | "neutral" {
  const d = difficulty.toLowerCase();
  if (d.includes("begin") || d.includes("easy")) return "good";
  if (d.includes("adv") || d.includes("hard")) return "warn";
  return "neutral";
}
