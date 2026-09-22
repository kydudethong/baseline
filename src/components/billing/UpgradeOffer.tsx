"use client";

import { useState } from "react";

export interface UpgradeOfferData {
  analysisId: string;
  canBuyGame: boolean;
  canUpgradePlan: boolean;
  prices: { plan: string; game: string } | null;
}

/**
 * Out of free minutes: the two ways to keep going, side by side.
 *
 * One game or the month. Put together because they answer different people
 * -- somebody trying it wants one more read, somebody who plays weekly wants
 * the plan -- and showing only the plan asks the first person for a
 * commitment they have not got to yet.
 */
export function UpgradeOffer({ offer }: { offer: UpgradeOfferData }) {
  const [busy, setBusy] = useState<"plan" | "game" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const go = async (kind: "plan" | "game") => {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(kind === "game" ? { kind, analysisId: offer.analysisId } : { kind }),
      });
      const j = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !j.url) throw new Error(j.error ?? "Could not start checkout.");
      window.location.href = j.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start checkout.");
      setBusy(null);
    }
  };

  if (!offer.canBuyGame && !offer.canUpgradePlan) return null;

  return (
    <div className="card stack g3">
      <p className="eyebrow">Keep going</p>
      <div className="row g2" style={{ flexWrap: "wrap" }}>
        {offer.canBuyGame ? (
          <button type="button" className="btn btn-soft" disabled={busy !== null} onClick={() => go("game")}>
            {busy === "game" ? "Opening checkout…" : `Analyse this game — ${offer.prices?.game ?? "one game"}`}
          </button>
        ) : null}
        {offer.canUpgradePlan ? (
          <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => go("plan")}>
            {busy === "plan"
              ? "Opening checkout…"
              : `90 minutes a month — ${offer.prices?.plan ? `${offer.prices.plan}/mo` : "monthly plan"}`}
          </button>
        ) : null}
      </div>
      <p className="sm" style={{ margin: 0, color: "var(--ink-3)" }}>
        Your court and your tag are saved — after paying you come straight back here to press Analyse.
        {offer.canUpgradePlan ? " The monthly plan is about six games and you can cancel any time." : ""}
      </p>
      {error ? <p className="sm" style={{ margin: 0, color: "var(--bad)" }}>{error}</p> : null}
    </div>
  );
}
