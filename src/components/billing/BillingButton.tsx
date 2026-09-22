"use client";

import { useState } from "react";

/**
 * Upgrade, or manage what you already pay for. One button, whichever applies.
 */
export function BillingButton({ plan, planPrice }: { plan: "free" | "pro"; planPrice: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(plan === "pro" ? "/api/billing/portal" : "/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: plan === "pro" ? undefined : JSON.stringify({ kind: "plan" }),
      });
      const j = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !j.url) throw new Error(j.error ?? "Could not open billing.");
      window.location.href = j.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open billing.");
      setBusy(false);
    }
  };

  return (
    <span className="row g2" style={{ display: "inline-flex", alignItems: "center", flexWrap: "wrap" }}>
      <button type="button" className={`btn btn-sm ${plan === "pro" ? "btn-ghost" : "btn-soft"}`} disabled={busy} onClick={go}>
        {busy ? "Opening…" : plan === "pro"
          ? "Manage billing"
          : `Get 90 min/month${planPrice ? ` — ${planPrice}` : ""}`}
      </button>
      {error ? <span className="sm" style={{ color: "var(--bad)" }}>{error}</span> : null}
    </span>
  );
}
