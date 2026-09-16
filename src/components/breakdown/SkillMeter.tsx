import { skillGuide } from "@/lib/coaching/skill-guide";

/**
 * Single-analysis skill meter — shows what one specific analysis measured:
 * a 1-5 rating as a filled bar, plus the model's stated basis for it. For
 * the recency-weighted score aggregated across every analysis, see the
 * Practice page (src/app/dashboard/practice/page.tsx) and
 * src/lib/coaching/stats.ts's getSkillProfiles — that's the cross-analysis
 * view this component deliberately doesn't try to be.
 *
 * THE INFO ICON EXISTS BECAUSE A NUMBER IS NOT A HANDLE. "Kitchen game: 2"
 * tells a player where they stand and nothing about what to do, and the
 * model's basis explains this clip without explaining the skill. Behind the
 * icon: what the skill is, what good looks like, how it usually goes wrong,
 * and one thing to work on — written once in skill-guide.ts rather than
 * generated, because none of it changes between Tuesday and Thursday.
 *
 * A <details> rather than a tooltip or a popover: it works on a phone, it
 * works before hydration, it is keyboard-reachable for free, and a tooltip
 * holding four paragraphs is not a tooltip.
 */
export function SkillMeter({
  name, raw, basis, skillKey,
}: {
  name: string;
  raw: number;
  basis: string | null;
  /** Keys the guide. Omit and the meter renders exactly as it always did. */
  skillKey?: string;
}) {
  const pct = Math.max(0, Math.min(100, (raw / 5) * 100));
  const guide = skillKey ? skillGuide(skillKey) : null;

  return (
    <div className="meter">
      <div className="meter-top">
        <span className="nm">
          {name}
          {guide ? (
            <details className="skill-info">
              <summary
                className="skill-info-ic"
                aria-label={`What ${name} means and how to improve it`}
                title={`What ${name} means and how to improve it`}
              >
                i
              </summary>
              <div className="skill-info-body">
                <p className="skill-info-what">{guide.what}</p>

                <div className="skill-info-row">
                  <span className="skill-info-lbl good">When it is a strength</span>
                  <p>{guide.strength}</p>
                </div>
                <div className="skill-info-row">
                  <span className="skill-info-lbl warn">How it usually goes wrong</span>
                  <p>{guide.weakness}</p>
                </div>
                <div className="skill-info-row">
                  <span className="skill-info-lbl">How to improve it</span>
                  <p>{guide.improve}</p>
                </div>

                {/* THIS GAME, kept visibly separate from the general advice
                    above it. The three blocks are true of every player; this
                    line is the only part that is about you, and blurring the
                    two would make generic coaching look personalised. */}
                {basis ? (
                  <div className="skill-info-row">
                    <span className="skill-info-lbl">Why this rating, in this game</span>
                    <p>{basis}</p>
                  </div>
                ) : null}
              </div>
            </details>
          ) : null}
        </span>
        <span className="sc">
          {raw}
          <small>/5</small>
        </span>
      </div>
      <div className="track">
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>
      {basis ? <p className="xs">{basis}</p> : null}
    </div>
  );
}
