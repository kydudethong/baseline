"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The coaching pass failed, and the page says so.
 *
 * WHY THIS EXISTS. The CV run and the coaching read are separate, deliberately
 * -- a coaching call that fails must not turn a good CV run into a failed one,
 * so the analysis is marked "completed" before it is attempted. The cost of
 * that, until now, was a page marked Completed with every panel on it empty
 * and nothing anywhere explaining the difference between "this clip had no
 * rallies in it" and "the read never ran". Reported exactly that way: "after I
 * analyzed, it doesn't show anything".
 *
 * The reason was never missing, only unreachable: it went to the container's
 * stdout, where the person looking at the blank page cannot get at it.
 */
export function CoachingFailureNote({
  analysisId,
  reason,
}: {
  analysisId: string;
  reason: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      // No body: the route falls back to the tag already on the analysis, so
      // this is a plain "try that again" rather than a re-tagging.
      const res = await fetch(`/api/analyses/${analysisId}/coach`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `The coaching run would not start (${res.status}).`);
      }
      // Started, not finished -- the run continues on the server and reports
      // through progress. Refreshing is what picks that up.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the coaching read.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="errbox">
      <p className="errbox-t">The coaching read didn&apos;t run for this clip</p>
      <p className="errbox-b">
        Everything Baseline measured is still here — the court, the players and the
        tracking all finished. It was the read on top of them that failed, which is
        why the panels below are empty.
      </p>
      {/* THE REASON, VERBATIM. It is written for a developer rather than for a
          player, and showing it anyway is still the right trade: a person who
          cannot act on it can paste it to somebody who can, where a friendly
          paraphrase loses the one detail that identifies the fault. */}
      <p className="sm" style={{ margin: "8px 0 0", color: "var(--ink-3)", fontFamily: "var(--mono, monospace)" }}>
        {reason}
      </p>
      <div className="row g2" style={{ marginTop: "var(--a3)", alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={retry}>
          {busy ? "Starting…" : "Try the read again"}
        </button>
        <span className="sm" style={{ color: "var(--ink-3)" }}>
          Re-running is free — it is the same footage, so it does not use any of your minutes.
        </span>
      </div>
      {error ? <p className="sm" style={{ margin: "8px 0 0", color: "var(--bad)" }}>{error}</p> : null}
    </div>
  );
}
