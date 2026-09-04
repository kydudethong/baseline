// The court and the ball, drawn to real proportions — ported from the
// original coach app's Motifs.tsx. A pickleball player notices when a
// court illustration is wrong, so these stay geometrically honest (44 x 20
// ft with a 7 ft kitchen) rather than decorative.

export function Ball({ size = 24, spin = false }: { size?: number; spin?: boolean }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32" aria-hidden="true"
      className={spin ? "spin-ball" : undefined}
      style={{ display: "inline-block", verticalAlign: "middle", flex: "none" }}
    >
      <circle cx="16" cy="16" r="15" fill="var(--optic)" />
      <g fill="var(--optic-ink)" opacity=".55">
        <circle cx="16" cy="7.5" r="2.1" /><circle cx="23.5" cy="12" r="2.1" />
        <circle cx="23.5" cy="20.5" r="2.1" /><circle cx="16" cy="24.5" r="2.1" />
        <circle cx="8.5" cy="20.5" r="2.1" /><circle cx="8.5" cy="12" r="2.1" />
        <circle cx="16" cy="16" r="2.1" />
      </g>
    </svg>
  );
}

/** A paddle, used as a feature/category marker wherever the ball icon
 * would be too literal (drills, feature cards) — currentColor so it
 * inherits whatever ink tone the surrounding text uses. */
export function Paddle({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"
      style={{ display: "inline-block", verticalAlign: "middle", flex: "none" }}
    >
      <rect x="6" y="2.5" width="12" height="14" rx="6" stroke="currentColor" strokeWidth="1.5" />
      <line x1="12" y1="16.5" x2="12" y2="21.5" stroke="currentColor" strokeWidth="1.5" />
      <line x1="9.3" y1="21.5" x2="14.7" y2="21.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** The net, low-profile — used as a section divider marker on
 * court-related screens. currentColor throughout. */
export function Net({ width = 34, height = 20 }: { width?: number; height?: number }) {
  return (
    <svg
      width={width} height={height} viewBox="0 0 34 20" fill="none" aria-hidden="true"
      style={{ display: "inline-block", verticalAlign: "middle", flex: "none" }}
    >
      <line x1="1" y1="4" x2="1" y2="19" stroke="currentColor" strokeWidth="1.4" />
      <line x1="33" y1="4" x2="33" y2="19" stroke="currentColor" strokeWidth="1.4" />
      <line x1="1" y1="4" x2="33" y2="4" stroke="currentColor" strokeWidth="1.6" />
      {[4, 9, 14, 19, 24, 29].map((x) => (
        <line key={x} x1={x} y1="4" x2={x} y2="17" stroke="currentColor" strokeWidth=".7" />
      ))}
    </svg>
  );
}

/** A proportionally-correct top-down court diagram (44 x 20 ft, 7 ft
 * kitchen each side of the net, center service line in each service
 * box) for use as a low-opacity watermark. Not decoration divorced
 * from the real geometry — an actual court, just faint. */
export function CourtWatermark({ className, opacity = 0.07 }: { className?: string; opacity?: number }) {
  return (
    <svg
      className={className}
      viewBox="0 0 440 200"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    >
      <rect x="1" y="1" width="438" height="198" fill="none" stroke="var(--ink)" strokeOpacity={opacity * 6} strokeWidth="2" />
      <line x1="220" y1="0" x2="220" y2="200" stroke="var(--ink)" strokeOpacity={opacity * 8} strokeWidth="3" />
      <line x1="150" y1="0" x2="150" y2="200" stroke="var(--ink)" strokeOpacity={opacity * 6} strokeWidth="2" />
      <line x1="290" y1="0" x2="290" y2="200" stroke="var(--ink)" strokeOpacity={opacity * 6} strokeWidth="2" />
      <line x1="0" y1="100" x2="150" y2="100" stroke="var(--ink)" strokeOpacity={opacity * 6} strokeWidth="2" />
      <line x1="290" y1="100" x2="440" y2="100" stroke="var(--ink)" strokeOpacity={opacity * 6} strokeWidth="2" />
      <rect x="150" y="0" width="140" height="200" fill="var(--optic)" fillOpacity={opacity} />
    </svg>
  );
}

export function Check({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.8" aria-hidden="true">
      <path d="M3 8.5l3.5 3.5L13 5" />
    </svg>
  );
}

export function PlayIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size * 1.15} viewBox="0 0 12 13" fill="currentColor" aria-hidden="true">
      <path d="M1 1l10 5.5L1 12z" />
    </svg>
  );
}
