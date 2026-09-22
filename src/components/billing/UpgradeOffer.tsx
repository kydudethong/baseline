"use client";

import { useState } from "react";

export interface UpgradeOfferData {
  /** The live price from Stripe, or null if it could not be read. */
  planPrice: string | null;
}

/**
 * Out of free minutes: the plan, one button.
 */
export function UpgradeOffer({ offer }: { offer: UpgradeOfferData }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !j.url) throw new Error(j.error ?? "Could not start checkout.");
      window.location.href = j.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start checkout.");
      setBusy(false);
    }
  };

  return (
    <div className="card stack g3">
      <p className="eyebrow">Keep going</p>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={go} style={{ alignSelf: "flex-start" }}>
        {busy ? "Opening checkout…" : `Get 90 minutes a month${offer.planPrice ? ` — ${offer.planPrice}/mo` : ""}`}
      </button>
      <p className="sm" style={{ margin: 0, color: "var(--ink-3)" }}>
        About six games a month, cancel any time. Your court and your tag are saved — after
        subscribing, come back here and press Analyse.
      </p>
      {error ? <p className="sm" style={{ margin: 0, color: "var(--bad)" }}>{error}</p> : null}
    </div>
  );
}
