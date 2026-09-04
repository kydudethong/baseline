"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Ported from coach's Ui.tsx StepToggle — now wired to a real endpoint (see blueprint-steps/[stepId]/route.ts) instead of being display-only. */
export function StepToggle({
  analysisId,
  stepId,
  done,
  idx,
}: {
  analysisId: string;
  stepId: string;
  done: boolean;
  idx: number;
}) {
  const router = useRouter();
  const [checked, setChecked] = useState(done);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = !checked;
    setChecked(next);
    setBusy(true);
    try {
      const res = await fetch(`/api/analyses/${analysisId}/blueprint-steps/${stepId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ done: next }),
      });
      if (!res.ok) throw new Error();
      router.refresh();
    } catch {
      setChecked(!next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className="bp-mk"
      disabled={busy}
      aria-label={checked ? `Mark session ${idx + 1} not done` : `Mark session ${idx + 1} done`}
      onClick={() => void toggle()}
    >
      {checked ? "✓" : idx + 1}
    </button>
  );
}
