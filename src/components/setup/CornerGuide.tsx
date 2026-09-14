/**
 * A worked example of where the four court corners go.
 *
 * WHY A DRAWING AND NOT A PHOTO. The instruction "click the four corners of
 * the court, starting at the near-left" is unambiguous to somebody who has
 * done it and genuinely ambiguous to somebody who has not: is "near-left" my
 * left or the camera's? Is the corner where the baseline meets the sideline,
 * or the outside edge of the painted line? Does the far baseline mean the
 * actual baseline when half the court is out of frame?
 *
 * Words cannot answer that as fast as a picture can, and a photo of a real
 * court would answer it for ONE camera angle — the reader then has to decide
 * whether their court looks enough like the photo. A schematic drawn at the
 * same perspective as a typical phone-on-a-fence shot shows the rule rather
 * than one instance of it, and it renders at any size with no asset to ship.
 *
 * The numbers are the click ORDER, which is the part people get wrong: the
 * corners must go round the court, not diagonally across it.
 */
export function CornerGuide({ compact = false }: { compact?: boolean }) {
  return (
    <figure className={`corner-guide${compact ? " compact" : ""}`}>
      <svg viewBox="0 0 320 200" role="img" aria-label="Where the four court corners go">
        <title>Click the corners in order: near-left, near-right, far-right, far-left</title>

        {/* The court in a typical camera perspective: near edge wide, far edge
            narrow, because a phone on a fence is never square to the court. */}
        <polygon points="40,178 280,178 226,58 94,58" fill="var(--blue-wash)" stroke="var(--blue-deep)" strokeWidth="2.5" />

        {/* Net across the middle, and the two kitchen lines either side of it. */}
        <line x1="86" y1="40" x2="234" y2="40" stroke="var(--ink-3)" strokeWidth="2" strokeDasharray="4 3" />
        <line x1="72" y1="118" x2="248" y2="118" stroke="var(--blue-deep)" strokeWidth="1.5" opacity="0.55" />
        <line x1="100" y1="72" x2="220" y2="72" stroke="var(--blue-deep)" strokeWidth="1.5" opacity="0.55" />
        <text x="160" y="34" textAnchor="middle" className="cg-note">net</text>
        <text x="160" y="133" textAnchor="middle" className="cg-note">kitchen line</text>

        {/* The four clicks, numbered in order. */}
        {[
          { n: 1, x: 40, y: 178, label: "Near-left", ax: 14, ay: 14 },
          { n: 2, x: 280, y: 178, label: "Near-right", ax: -14, ay: 14 },
          { n: 3, x: 226, y: 58, label: "Far-right", ax: -12, ay: -12 },
          { n: 4, x: 94, y: 58, label: "Far-left", ax: 12, ay: -12 },
        ].map((c) => (
          <g key={c.n}>
            <circle cx={c.x} cy={c.y} r="11" fill="var(--blue-deep)" />
            <text x={c.x} y={c.y + 4} textAnchor="middle" className="cg-num">{c.n}</text>
            <text
              x={c.x + c.ax}
              y={c.y + c.ay + (c.ay > 0 ? 8 : -6)}
              textAnchor={c.ax > 0 ? "start" : "end"}
              className="cg-lbl"
            >
              {c.label}
            </text>
          </g>
        ))}
      </svg>

      <figcaption>
        <strong>Go round the court, not across it.</strong> Start at the baseline nearest the
        camera on the left, then the same baseline on the right, then the two far corners.
        Click where the lines <em>meet</em> — the outside edge of the paint is fine, just be
        consistent. If the far baseline is out of shot, use the far sideline where it leaves
        the frame; Baseline works it out from the kitchen lines.
      </figcaption>
    </figure>
  );
}
