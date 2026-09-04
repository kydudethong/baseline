const STEPS = [
  {
    step: "01",
    title: "Upload your match",
    body: "Drop in a recording from a tripod, a friend's phone, or a court camera. MP4, MOV, and most common formats work.",
  },
  {
    step: "02",
    title: "We process the footage",
    body: "Your video is validated, its metadata is read, and it's prepared for analysis — safely stored, never public.",
  },
  {
    step: "03",
    title: "Get a breakdown",
    body: "See player tracking, shot patterns, and court positioning laid out alongside your video, not buried in a spreadsheet.",
  },
  {
    step: "04",
    title: "Know what to work on",
    body: "Plain-language coaching insights point at specific, fixable habits — not just a wall of stats.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" style={{ borderBottom: "1px solid var(--line)", background: "var(--card)" }}>
      <div style={{ maxWidth: 1140, margin: "0 auto", padding: "var(--a7) var(--a5)" }}>
        <div className="stack g2" style={{ maxWidth: "44ch", marginBottom: "var(--a6)" }}>
          <h2 className="d2">How it works</h2>
          <p className="body">Four steps between raw footage and something you can actually use at your next practice.</p>
        </div>
        <div className="grid2" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}>
          {STEPS.map((s) => (
            <div key={s.step} className="stack g1">
              <span className="eyebrow" style={{ color: "var(--blue-deep)" }}>
                {s.step}
              </span>
              <h3 className="h3" style={{ marginTop: "4px", color: "var(--ink)" }}>
                {s.title}
              </h3>
              <p className="sm">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
