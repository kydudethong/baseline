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
  name, raw, basis,
}: {
  name: string;
  raw: number;
  basis: string | null;
}) {
  const pct = Math.max(0, Math.min(100, (raw / 5) * 100));

  return (
    <div className="meter">
      <div className="meter-top">
        {/* The info icon moved to the GROUP tiles on the radar, which are
            what the chart actually shows. A meter listing one skill inside a
            group does not need to re-explain the group. */}
        <span className="nm">{name}</span>
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
