"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AnalysisStatus } from "@/lib/db/types";

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
      <p className="flex items-center gap-2 text-sm text-slate-600">
        <span className="h-2 w-2 animate-pulse rounded-full bg-amber-600" />
        {status === "queued" ? "Queued for processing…" : "Processing…"} This page updates
        automatically.
      </p>
    );
  }

  if (status === "uploaded" || status === "failed") {
    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={start}
          disabled={busy}
          className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60"
        >
          {busy ? "Starting…" : status === "failed" ? "Retry processing" : "Start processing"}
        </button>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </div>
    );
  }

  return null;
}
