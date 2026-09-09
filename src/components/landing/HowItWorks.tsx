const STEPS = [
  {
    step: "01",
    title: "Upload your match",
    body: "A tripod, a friend's phone, or a court camera. Fixed camera, whole court in frame, one game per clip works best — MP4 and MOV are fine.",
  },
  {
    step: "02",
    title: "Mark the court, tag yourself",
    body: "Baseline finds the court lines and the players itself; you check them and click which one is you. About a minute, and it's what makes the rest measured rather than guessed.",
  },
  {
    step: "03",
    title: "Watch it work",
    body: "Court, players, ball, contacts, rallies — each stage ticks off as it finishes. No fake percentage, because the pipeline genuinely doesn't know how far through it is.",
  },
  {
    step: "04",
    title: "Read it beside the film",
    body: "Pick a rally, the video jumps there. Pick a contact, you see what your body did and why the shot was called what it was — with the coaching on that rally next to it.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" style={{ borderBottom: "1px solid var(--line)", background: "var(--card)" }}>
      <div style={{ maxWidth: 1140, margin: "0 auto", padding: "var(--a7) var(--a5)" }}>
        <div className="stack g2" style={{ maxWidth: "44ch", marginBottom: "var(--a6)" }}>
          <h2 className="d2">How it works</h2>
          <p className="body">Four steps between raw footage and something you can use at your next practice.</p>
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
