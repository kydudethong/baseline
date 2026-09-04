"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Small inline trigger next to one weakness observation — see blueprint.ts. Rendered from CoachingReadPanel.tsx inside an .evid row, a server component; this is the client-interactive slice of it. */
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
    <>
      <button type="button" onClick={() => void build()} disabled={busy}>
        {busy ? "Building plan…" : "Build a 5-session plan"}
      </button>
      {error ? <span className="xs" style={{ color: "var(--bad)" }}>{error}</span> : null}
    </>
  );
}
