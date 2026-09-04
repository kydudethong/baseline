"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AnalysisStatus } from "@/lib/db/types";
import { Ball } from "@/components/motifs/Motifs";

/**
 * Drives the state machine from the client side: starts/retries processing,
 * and polls while a run is in flight so the page updates without a manual
 * refresh. Polling (not a subscription) is the right amount of complexity
 * for a synchronous, single-request pipeline — see pipeline.ts.
 */
export function ProcessingControls({
  analysisId,
  status,
}: {
  analysisId: string;
  status: AnalysisStatus;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const inFlight = status === "queued" || status === "processing";

  useEffect(() => {
    if (!inFlight) {
      if (pollingRef.current) clearInterval(pollingRef.current);
      return;
    }
    pollingRef.current = setInterval(() => router.refresh(), 3000);
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [inFlight, router]);

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

  if (inFlight) {
    return (
      <div className="panel-live" role="status" aria-live="polite">
        <span className="ic">
          <Ball size={24} spin />
        </span>
        <div className="stack g2" style={{ minWidth: 0 }}>
          <p className="h3">{status === "queued" ? "Queued — starting shortly" : "Tracking the court and every player"}</p>
          <p className="sm measure">
            Baseline is finding the court lines, following each player through the clip, and picking out the
            rallies from the paddle contacts. Longer clips take longer; this page updates by itself when it&apos;s
            done, so you can leave and come back.
          </p>
          <div className="progress indet" style={{ maxWidth: 320 }}>
            <div className="bar" />
          </div>
        </div>
      </div>
    );
  }

  if (status === "uploaded" || status === "failed") {
    return (
      <div className="stack g3" style={{ alignItems: "flex-start" }}>
        <button type="button" onClick={start} disabled={busy} className="btn btn-optic">
          {busy ? "Starting…" : status === "failed" ? "Try processing again" : "Start processing"}
        </button>
        {error ? <div className="error">{error}</div> : null}
      </div>
    );
  }

  return null;
}
