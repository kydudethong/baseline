/**
 * Single-analysis skill meter — shows what one specific analysis measured:
 * a 1-5 rating as a filled bar, plus the model's stated basis for it. For
 * the recency-weighted score aggregated across every analysis, see the
 * Practice page (src/app/dashboard/practice/page.tsx) and
 * src/lib/coaching/stats.ts's getSkillProfiles — that's the cross-analysis
 * view this component deliberately doesn't try to be.
 */
export function SkillMeter({ name, raw, basis }: { name: string; raw: number; basis: string | null }) {
  const pct = Math.max(0, Math.min(100, (raw / 5) * 100));
  return (
    <div className="meter">
      <div className="meter-top">
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
