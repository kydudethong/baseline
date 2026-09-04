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
      <circle cx="16" cy="16" r="15" fill="#E4F03F" />
      <g fill="#10222B" opacity=".55">
        <circle cx="16" cy="7.5" r="2.1" /><circle cx="23.5" cy="12" r="2.1" />
        <circle cx="23.5" cy="20.5" r="2.1" /><circle cx="16" cy="24.5" r="2.1" />
        <circle cx="8.5" cy="20.5" r="2.1" /><circle cx="8.5" cy="12" r="2.1" />
        <circle cx="16" cy="16" r="2.1" />
      </g>
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
