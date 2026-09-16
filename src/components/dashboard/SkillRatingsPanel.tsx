import Link from "next/link";
import type { CoachingSkillRatingRow } from "@/lib/db/types";
import { SKILLS, skillName } from "@/lib/coaching/types";
import { SkillMeter } from "@/components/breakdown/SkillMeter";
import { SkillRadar } from "@/components/breakdown/SkillRadar";

/**
 * The shape of a game, with its reasoning one click away.
 *
 * THE RADAR AND THE REASONS USED TO BE STRANGERS. The chart sat near the
 * bottom of the page and the per-skill explanations sat in a different section
 * entirely, so the two things a rating needs -- where it sits, and why it sits
 * there -- were separated by several screens of coaching. Someone who
 * disagreed with an axis had nowhere to go from it.
 *
 * Now the reasons hang off the chart they explain, behind a disclosure. Open
 * by default would be a wall of paragraphs under a picture that is already
 * legible on its own; hidden and reachable is the right shape for a thing you
 * consult when something surprises you.
 */
export function SkillRatingsPanel({ skills }: { skills: CoachingSkillRatingRow[] }) {
  if (skills.length === 0) return null;

  // DECISIONS IS OFF THE CHART, so its ratings do not belong under it either.
  // Leaving the explanations in while the axis is gone would have people
  // hunting a chart for a skill that is not drawn on it.
  const groupOf = new Map(SKILLS.map((s) => [s.key, s.group]));
  const shown = skills.filter((s) => groupOf.get(s.skill_key) !== "Decisions");
  if (shown.length === 0) return null;

  const withReasons = shown.filter((s) => s.basis && s.basis.trim());

  return (
    <section className="stack g4">
      <h2 className="eyebrow">Where those ratings sit against each other</h2>
      <div className="card">
        <SkillRadar skills={shown} />
      </div>

      {withReasons.length > 0 ? (
        <details className="card">
          <summary className="sm" style={{ cursor: "pointer" }}>
            See why — the rating behind each point on the chart
          </summary>
          <div className="grid2" style={{ marginTop: 12 }}>
            {withReasons.map((s) => (
              <SkillMeter
                key={s.id}
                name={skillName(s.skill_key)}
                raw={s.raw}
                basis={s.basis}
              />
            ))}
          </div>
        </details>
      ) : null}

      <p className="note">
        <Link href="/dashboard/practice" className="crumb" style={{ color: "var(--blue)" }}>
          See how each skill is trending across your games →
        </Link>
      </p>
    </section>
  );
}
