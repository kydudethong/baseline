/**
 * Single-analysis skill meter — a simpler cousin of coach's original Meter
 * (which showed a recency-weighted score aggregated across many sessions).
 * Baseline doesn't have cross-analysis aggregation yet (see PHASE3
 * deliverables §7), so this shows just what this one analysis measured:
 * a 1-5 rating as a filled bar, plus the model's stated basis for it.
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
