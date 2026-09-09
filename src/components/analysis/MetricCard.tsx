/**
 * One measured number, or an honest statement that it was not measured.
 *
 * The `null` path is the point of this component. Every mechanics field can
 * legitimately be absent — legs hidden at contact, the pose burst missing that
 * moment — and rendering a missing knee angle as "0°" would be a claim the
 * system never made. So absent renders as "Not available", in muted italic,
 * visibly different from a real reading.
 */
export function MetricCard({
  label, value, unit, decimals = 0, note, unavailableNote,
}: {
  label: string;
  /** null means NOT MEASURED. Never pass 0 to mean "we don't know". */
  value: number | null | undefined;
  unit?: string;
  decimals?: number;
  note?: string;
  /** Why it is missing, when the pipeline said. */
  unavailableNote?: string;
}) {
  const missing = value === null || value === undefined || !Number.isFinite(value);
  return (
    <div className={`metric${missing ? " metric-na" : ""}`}>
      <div className="metric-k">{label}</div>
      <div className="metric-v">
        {missing ? "Not available" : (
          <>
            {value.toFixed(decimals)}
            {unit ? <span className="metric-u">{unit}</span> : null}
          </>
        )}
      </div>
      {missing
        ? (unavailableNote ? <div className="metric-why">{unavailableNote}</div> : null)
        : (note ? <div className="metric-why">{note}</div> : null)}
    </div>
  );
}
