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
    <section id="how-it-works" className="border-b border-slate-200 bg-white">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="mb-12 max-w-2xl">
          <h2 className="text-3xl font-bold tracking-tight text-slate-900">
            How it works
          </h2>
          <p className="mt-3 text-slate-600">
            Four steps between raw footage and something you can actually use
            at your next practice.
          </p>
        </div>
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <div key={s.step}>
              <span className="text-sm font-semibold text-emerald-700">{s.step}</span>
              <h3 className="mt-2 text-lg font-semibold text-slate-900">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
