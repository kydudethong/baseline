import type { AnalysisResult } from "@/lib/db/types";

/**
 * analyses.result is the pipeline's own run summary (frames sampled,
 * tracks produced, known limitations) — useful to a developer on the
 * debug page, but it is not something a player should be reading as
 * "analysis". The only thing it renders here is the one message that
 * really is for the user: that a mock provider generated this run, so
 * the numbers on the page are placeholders.
 */
export function AnalysisResultPanel({ result }: { result: AnalysisResult }) {
  if (result.source !== "mock") return null;

  return (
    <div className="note" style={{ borderLeft: "4px solid var(--warn)" }}>
      <strong style={{ color: "var(--ink)" }}>Development data.</strong> This run used a placeholder
      vision provider, not the real court tracker, so the measurements on this page are stand-ins.
    </div>
  );
}
