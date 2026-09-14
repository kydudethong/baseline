"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Remove / restore / delete, on one library card.
 *
 * TWO DIFFERENT DESTRUCTIVE ACTIONS, deliberately not collapsed into one
 * button. "Remove" is the thing people actually mean almost every time -- get
 * this off my list, take it out of my calendar -- and it is reversible, so it
 * needs no confirmation and no warning. "Delete permanently" destroys the
 * video, the coaching read, the ratings and the technique pass, and it is
 * behind the archive view and a typed confirmation, because there is no undo
 * and a card grid is a very easy place to misclick.
 *
 * The menu lives in a client component rather than the server-rendered card
 * because it needs the click. It is deliberately NOT nested inside the card's
 * Link -- a button inside an anchor navigates as well as acts, so removing a
 * video would also open it.
 */
export function LibraryCardMenu({
  analysisId,
  title,
  archived,
}: {
  analysisId: string;
  title: string;
  archived: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "archive" | "restore" | "delete") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/analyses/${analysisId}/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "That didn't work.");
      setConfirming(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  if (confirming) {
    return (
      <div className="stack g2" style={{ width: "100%" }}>
        <p className="xs" style={{ color: "var(--bad)" }}>
          Delete <strong>{title}</strong> for good? The video, its coaching read, ratings and
          technique notes all go. This cannot be undone.
        </p>
        <div className="row g2">
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirming(false)}>
            Keep it
          </button>
          <button
            type="button"
            className="btn btn-sm"
            style={{ background: "var(--bad)", color: "#fff" }}
            disabled={busy}
            onClick={() => act("delete")}
          >
            {busy ? "Deleting…" : "Delete permanently"}
          </button>
        </div>
        {error ? <p className="xs" style={{ color: "var(--bad)" }}>{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="row g2" style={{ width: "100%" }}>
      {archived ? (
        <>
          <button type="button" className="btn btn-soft btn-sm" disabled={busy} onClick={() => act("restore")}>
            {busy ? "…" : "Put back"}
          </button>
          <button
            type="button"
            className="btn btn-soft btn-sm"
            style={{ color: "var(--bad)" }}
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Delete permanently
          </button>
        </>
      ) : (
        <button type="button" className="btn btn-soft btn-sm" disabled={busy} onClick={() => act("archive")}>
          {busy ? "Removing…" : "Remove"}
        </button>
      )}
      {error ? <span className="xs" style={{ color: "var(--bad)" }}>{error}</span> : null}
    </div>
  );
}
