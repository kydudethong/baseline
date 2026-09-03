import Link from "next/link";

export function Hero({ analyzeHref }: { analyzeHref: string }) {
  return (
    <section className="border-b border-slate-200 bg-slate-50">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 sm:py-28 lg:grid-cols-2">
        <div>
          <p className="mb-4 inline-block rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-800">
            Now in early access
          </p>
          <h1 className="text-4xl font-bold leading-tight tracking-tight text-slate-900 sm:text-5xl">
            Turn game footage into a real coaching session.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-slate-600">
            Upload a recording of your match. Baseline breaks down your
            positioning, footwork, and readiness patterns — the way a coach
            would, without waiting a week for the video review.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link
              href={analyzeHref}
              className="rounded-lg bg-emerald-700 px-6 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-emerald-800"
            >
              Analyze Your Game
            </Link>
            <a
              href="#how-it-works"
              className="rounded-lg border border-slate-300 bg-white px-6 py-3 text-base font-semibold text-slate-700 transition hover:border-slate-400"
            >
              See How It Works
            </a>
          </div>
          <p className="mt-4 text-sm text-slate-500">
            Free while in early access. No credit card required.
          </p>
        </div>

        <div className="relative">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg">
            <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
              <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
              <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
              <span className="ml-2 text-xs font-medium text-slate-400">
                match_09-14.mp4 — processing
              </span>
            </div>
            <div className="space-y-3 p-5">
              <div className="aspect-video rounded-lg bg-slate-900" />
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-slate-700">Status</span>
                <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                  Processing
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div className="h-full w-2/3 rounded-full bg-emerald-600" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
