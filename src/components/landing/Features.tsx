const FEATURES = [
  {
    title: "Player & ball tracking",
    body: "Every player and every shot, tracked frame by frame across the court.",
  },
  {
    title: "Court positioning",
    body: "See where you stand during transitions, dinks, and drives — and where you should.",
  },
  {
    title: "Shot & event detection",
    body: "Serves, drives, dinks, and drops identified automatically, timestamped to the video.",
  },
  {
    title: "Session statistics",
    body: "Rally length, shot mix, and movement patterns, tracked match over match.",
  },
  {
    title: "AI coaching insights",
    body: "Specific, readable takeaways — not a dashboard you need a manual for.",
  },
  {
    title: "Private by default",
    body: "Your footage is yours. Stored privately and never used to train models on other users' behalf.",
  },
];

export function Features() {
  return (
    <section id="features" className="bg-slate-50">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="mb-12 max-w-2xl">
          <h2 className="text-3xl font-bold tracking-tight text-slate-900">
            What you get
          </h2>
          <p className="mt-3 text-slate-600">
            Built for players and coaches who want more than a highlight reel.
          </p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-xl border border-slate-200 bg-white p-6"
            >
              <h3 className="font-semibold text-slate-900">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
