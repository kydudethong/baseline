import type { AnalysisResult } from "@/lib/db/types";

export function AnalysisResultPanel({ result }: { result: AnalysisResult }) {
  const isMock = result.source === "mock";

  return (
    <div className="space-y-6">
      {isMock ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong className="font-semibold">Development data.</strong> This result was generated
          by a placeholder analysis engine, not real computer vision or AI coaching. It exists to
          demonstrate the pipeline end-to-end before RoboflowVisionProvider and a real
          AnalysisEngine are built.
        </div>
      ) : null}

      <section>
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Statistics
        </h3>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {Object.entries(result.statistics).map(([key, value]) => (
            <div key={key} className="rounded-lg border border-slate-200 bg-white p-4">
              <dt className="text-xs text-slate-500">{humanize(key)}</dt>
              <dd className="mt-1 text-xl font-semibold text-slate-900">{String(value)}</dd>
            </div>
          ))}
        </dl>
      </section>

      {result.events.length > 0 ? (
        <section>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Events
          </h3>
          <ul className="space-y-2">
            {result.events.map((event, i) => (
              <li
                key={i}
                className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm"
              >
                <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-600">
                  {formatTimestamp(event.timestampSeconds)}
                </span>
                <span className="text-slate-700">{event.description}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Insights
        </h3>
        <ul className="space-y-2 text-sm text-slate-700">
          {result.insights.map((insight, i) => (
            <li key={i} className="rounded-lg border border-slate-200 bg-white p-3">
              {insight}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Recommendations
        </h3>
        <ul className="space-y-2 text-sm text-slate-700">
          {result.recommendations.map((rec, i) => (
            <li key={i} className="rounded-lg border border-slate-200 bg-white p-3">
              {rec}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function humanize(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
