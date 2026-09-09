/**
 * How much weight to put on a number, as three pips.
 *
 * Deliberately not a percentage. "62% confident" implies a calibration the
 * pipeline does not have — these are heuristic scores from thresholds tuned on
 * a handful of clips. Three pips say the only thing that is actually true:
 * lean on this, or don't.
 */
export function ConfidenceIndicator({
  value, label, className = "",
}: {
  /** 0–1, or null when nothing scored it. */
  value: number | null;
  label?: string;
  className?: string;
}) {
  if (value === null || !Number.isFinite(value)) return null;
  const pips = value >= 0.66 ? 3 : value >= 0.4 ? 2 : 1;
  const tone = pips === 3 ? "high" : pips === 1 ? "low" : "";
  const words = pips === 3 ? "high confidence" : pips === 2 ? "moderate confidence" : "low confidence";
  return (
    <span className={`conf ${tone} ${className}`} title={`${label ? `${label}: ` : ""}${words}`}>
      <span className="conf-pips" aria-hidden>
        {[0, 1, 2].map((i) => <span key={i} className={`conf-pip${i < pips ? " on" : ""}`} />)}
      </span>
      <span className="sr-only">{words}</span>
    </span>
  );
}
