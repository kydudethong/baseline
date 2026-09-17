"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AnalysisStatus } from "@/lib/db/types";
import { AnalysisProgress } from "@/components/analysis/AnalysisProgress";

/**
 * Drives the state machine from the client side: starts/retries processing,
 * and hands a run in flight to AnalysisProgress, which polls the light
 * `?progress=1` endpoint and refreshes the page once when the run ends.
 *
 * This used to run its own router.refresh() every 3 seconds, re-rendering the
 * whole server tree — eleven tables — for four minutes to learn one status
 * string, and showed an indeterminate bar that told the user nothing about
 * what was happening. The stage list is both cheaper and true.
 */
export function ProcessingControls({
  analysisId,
  status,
  hasSetup = false,
}: {
  analysisId: string;
  status: AnalysisStatus;
  /** Whether the user has marked the court and players for this clip yet. */
  hasSetup?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inFlight = status === "queued" || status === "processing";

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/analyses/${analysisId}/process`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not start processing.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start processing.");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    // Asked, because it is destructive in the only way that matters: the work
    // done so far is in the process's memory and there is nothing to resume
    // from. Starting again starts from the beginning.
    if (!window.confirm(
      "Stop this analysis? The work done so far is lost and starting again begins from the top."
    )) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/analyses/${analysisId}/cancel`, { method: "POST" });
      const json = (await res.json()) as { error?: string; message?: string; wasRunning?: boolean };
      if (!res.ok) throw new Error(json.error ?? "Could not stop the analysis.");
      // Said out loud when the run had already died with its machine, because
      // "stopped" would imply this click did something it did not, and the
      // user has probably been watching a stuck progress bar for a while.
      if (json.wasRunning === false && json.message) setError(json.message);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not stop the analysis.");
    } finally {
      setBusy(false);
    }
  }

  if (inFlight) {
    return (
      <div className="stack g3">
        <AnalysisProgress analysisId={analysisId} initialStatus={status} />
        <div className="row g2" style={{ alignItems: "center" }}>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={stop}>
            {busy ? "Stopping…" : "Stop analysis"}
          </button>
          <span className="sm" style={{ opacity: 0.6 }}>
            Nothing happens to your video — the clip stays exactly as it is.
          </span>
        </div>
        {error ? <div className="error">{error}</div> : null}
      </div>
    );
  }

  // Every state that is not mid-run gets the setup link. An earlier version
  // only rendered it for "uploaded" and "failed", which meant that once a clip
  // had been analysed there was no way to reach setup at all -- exactly when
  // you most want it, having just seen the overlay get the court wrong.
  const setupLink = (primary: boolean) => (
    // A bare `btn` has a transparent border and no fill, so it rendered as
    // bold text rather than a control. `btn-soft` is the secondary button.
    <Link href={`/dashboard/${analysisId}/setup`} className={primary ? "btn btn-optic" : "btn btn-soft"}>
      {hasSetup ? "Check the court" : "Line up the court"}
    </Link>
  );

  if (status === "uploaded" || status === "failed") {
    // NO "SKIP SETUP" BUTTON ANY MORE, because there is nothing left to skip
    // to. Nothing detects a court, so a run without one has no scale at all --
    // and a court in the wrong place is worse than none, since every distance
    // is then produced and wrong with nothing able to notice. The server
    // refuses these runs; offering a button that leads to a 400 would just be
    // a slower way of saying the same thing.
    return (
      <div className="stack g3" style={{ alignItems: "flex-start" }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {!hasSetup ? setupLink(true) : null}
          <button type="button" onClick={start} disabled={busy || !hasSetup}
            title={hasSetup ? undefined : "Line up the court first"}
            className={hasSetup ? "btn btn-optic" : "btn btn-soft"}>
            {busy
              ? "Starting…"
              : status === "failed" ? "Try processing again" : "Start processing"}
          </button>
          {hasSetup ? setupLink(false) : null}
        </div>
        <p className="sm measure" style={{ opacity: 0.75 }}>
          {hasSetup
            ? "The court is marked for this clip. Processing will use it, and will write your coaching read at the end without asking again — you pick which player is you once the overlay is built."
            : "One thing before this can run: drag the court outline onto the painted lines. Every distance in the read is measured off it, and a court in the wrong place gives wrong numbers rather than missing ones. Takes about ten seconds."}
        </p>
        {error ? <div className="error">{error}</div> : null}
      </div>
    );
  }

  if (status === "completed") {
    // On a finished analysis these are a FOOTER, not a header. The page's
    // subject is the breakdown; "the court was wrong, fix it and run again" is
    // a thought you have after watching the video, not before. Above the
    // player it also pushed the thing the user came for below the fold. The
    // page positions it -- see the analysis page -- and this only has to look
    // like a place you arrive at rather than a thing you must get past.
    return (
      <section className="actionbar">
        <span className="actionbar-ic" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 0 1 15.5-6.2M21 12a9 9 0 0 1-15.5 6.2" />
            <path d="M18.5 3v3h-3M5.5 21v-3h3" />
          </svg>
        </span>
        <div className="actionbar-txt">
          <p className="actionbar-t">Something look wrong?</p>
          <p className="actionbar-d">
            {hasSetup
              ? "Re-running uses the court and players you marked, and rewrites the coaching read."
              : "If the overlay got the court wrong or followed the wrong people, mark them by hand and run it again."}
          </p>
          {error ? <div className="error" style={{ marginTop: 10 }}>{error}</div> : null}
        </div>
        <div className="actionbar-do">
          {setupLink(false)}
          <button type="button" onClick={start} disabled={busy} className="btn btn-optic">
            {busy ? "Starting…" : "Re-run analysis"}
          </button>
        </div>
      </section>
    );
  }

  return null;
}
