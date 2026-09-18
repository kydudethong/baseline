import { groupGuide, skillGuide } from "@/lib/coaching/skill-guide";

/**
 * What a rating means, and what to do about it.
 *
 * A NUMBER IS NOT A HANDLE. "Kitchen 3.00" tells a player where they stand and
 * nothing about what to do, and the model's one-line basis explains this clip
 * without explaining the skill. Behind the icon: what the thing is, what good
 * looks like, how it usually goes wrong, and one thing to work on.
 *
 * KEYED BY GROUP OR BY SKILL, because the chart shows groups. "Offense 4.00"
 * is an average of the serve, the third shot and attacking play, so the entry
 * has to describe the axis rather than one of the parts it was built from.
 *
 * A <details> rather than a tooltip: it works on a phone, it works before
 * hydration, it is keyboard-reachable for free, and a tooltip holding four
 * paragraphs is not a tooltip.
 */
export function SkillInfo({
  group, skillKey, basis, parts,
}: {
  /** A radar axis: Kitchen, Movement, Offense, Defense. */
  group?: string;
  /** Or one skill, for places that list skills rather than axes. */
  skillKey?: string;
  /** The model's reasoning for THIS game, kept separate from the general advice. */
  basis?: string | null;
  /**
   * What an averaged axis is actually made of, and why each part scored.
   *
   * THE ICON EXPLAINED THE SPORT, NOT THE PLAYER. This component has always
   * had a `basis` slot -- "Why this rating, in this game" -- and the one place
   * that renders it, the radar tile, never passed anything into it. So every
   * info icon on the page opened four paragraphs that are equally true of
   * everybody who has ever held a paddle, and the single line that was about
   * the person reading it was dead code.
   *
   * An axis is an average of several skills, so one sentence cannot explain it
   * honestly: "Offense 4.00" is the serve, the third shot and attacking play,
   * and the player's question is which of those pulled it up or down. Each
   * part arrives with its own number and its own reason.
   */
  parts?: Array<{ name: string; raw: number; basis: string | null }>;
}) {
  const guide = group ? groupGuide(group) : skillKey ? skillGuide(skillKey) : null;
  if (!guide) return null;
  const label = group ?? skillKey ?? "this rating";

  return (
    <details className="skill-info">
      <summary
        className="skill-info-ic"
        aria-label={`What ${label} means and how to improve it`}
        title={`What ${label} means and how to improve it`}
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

        {/* THIS GAME, kept visibly separate from the general advice above it.
            The three blocks are true of every player; what follows is the only
            part that is about you, and blurring the two would make generic
            coaching look personalised. */}
        {basis ? (
          <div className="skill-info-row">
            <span className="skill-info-lbl">Why this rating, in this game</span>
            <p>{basis}</p>
          </div>
        ) : null}

        {parts && parts.length > 0 ? (
          <div className="skill-info-row">
            <span className="skill-info-lbl">
              {parts.length === 1 ? "Why this number, in this game" : "What this number is made of"}
            </span>
            {parts.map((p) => (
              <p key={p.name}>
                <strong>{p.name} — {p.raw}/5.</strong>{" "}
                {p.basis?.trim()
                  ? p.basis
                  : "The coach rated this without writing down what it rested on."}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}
