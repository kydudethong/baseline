"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Small inline trigger next to one weakness observation — see blueprint.ts. Rendered from CoachingReadPanel.tsx, a server component; this is the client-interactive slice of it. */
export function BuildBlueprintButton({ analysisId, observationId }: { analysisId: string; observationId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function build() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/analyses/${analysisId}/blueprint`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ observationId }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not build a practice plan.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build a practice plan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={build}
        disabled={busy}
        className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 disabled:opacity-60"
      >
        {busy ? "Building practice plan…" : "Build a 5-session practice plan →"}
      </button>
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
