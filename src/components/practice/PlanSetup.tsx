"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const DAYS = [
  { n: 0, label: "Sun" }, { n: 1, label: "Mon" }, { n: 2, label: "Tue" }, { n: 3, label: "Wed" },
  { n: 4, label: "Thu" }, { n: 5, label: "Fri" }, { n: 6, label: "Sat" },
];

/**
 * The two questions a month of practice actually needs: how often, and which
 * days.
 *
 * TWO QUESTIONS AND NOT SEVEN. Every extra field here is a reason to close the
 * tab, and nothing else changes the output: the model decides what to practise
 * from the analyses it already has, and the only things it cannot know are how
 * much time this person has and when. Court preference, session length, goals
 * -- all of it is either already in the coaching read or better inferred than
 * asked.
 *
 * Regenerating an existing month warns before it runs, because it replaces the
 * month and the ticks go with it.
 */
export function PlanSetup({
  month,
  monthLabel,
  initialDays,
  initialSessions,
  hasExistingPlan,
  completedCount,
}: {
  month: string;
  monthLabel: string;
  initialDays: number[];
  initialSessions: number;
  hasExistingPlan: boolean;
  completedCount: number;
}) {
  const router = useRouter();
  const [days, setDays] = useState<Set<number>>(new Set(initialDays));
  const [sessions, setSessions] = useState(String(initialSessions));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function build() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/practice/month", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          month,
          playDays: [...days],
          sessionsPerMonth: Math.max(1, Math.min(31, Number(sessions) || 8)),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Couldn't build the month.");
      setConfirming(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't build the month.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack g4">
      <div className="stack g1">
        <span className="eyebrow">{hasExistingPlan ? "Rebuild" : "Set up"} {monthLabel}</span>
        <p className="sm" style={{ margin: 0 }}>
          Two things Baseline can&apos;t work out from your footage: how often you get on a court,
          and which days. Everything else comes from what your games already showed.
        </p>
      </div>

      <div className="stack g2">
        <span className="lbl-sm">Which days do you usually play?</span>
        <div className="row g2" style={{ flexWrap: "wrap" }}>
          {DAYS.map((d) => (
            <button
              key={d.n}
              type="button"
              className={`chip${days.has(d.n) ? " on" : ""}`}
              onClick={() =>
                setDays((prev) => {
                  const next = new Set(prev);
                  if (next.has(d.n)) next.delete(d.n);
                  else next.add(d.n);
                  return next;
                })
              }
            >
              {d.label}
            </button>
          ))}
        </div>
        <p className="xs">Pick none and Baseline will use any day of the month.</p>
      </div>

      <label className="stack g2" style={{ maxWidth: 260 }}>
        <span className="lbl-sm">Roughly how many sessions this month?</span>
        <input
          type="number"
          min={1}
          max={31}
          value={sessions}
          onChange={(e) => setSessions(e.target.value)}
          className="input"
        />
      </label>

      {confirming ? (
        <div className="note" style={{ borderLeft: "4px solid var(--warn)" }}>
          <strong style={{ color: "var(--ink)" }}>This replaces {monthLabel}.</strong>{" "}
          {completedCount > 0
            ? `You've ticked off ${completedCount} session${completedCount === 1 ? "" : "s"} this month — those go too.`
            : "Nothing is ticked off yet, so nothing is lost."}
          <div className="row g2" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirming(false)}>
              Keep what I have
            </button>
            <button type="button" className="btn btn-optic btn-sm" disabled={busy} onClick={build}>
              {busy ? "Building…" : "Rebuild the month"}
            </button>
          </div>
        </div>
      ) : (
        <div className="row g2">
          <button
            type="button"
            className="btn btn-optic"
            disabled={busy}
            onClick={() => (hasExistingPlan ? setConfirming(true) : build())}
          >
            {busy ? "Building your month…" : hasExistingPlan ? "Rebuild this month" : `Build ${monthLabel}`}
          </button>
        </div>
      )}

      {error ? <div className="error">{error}</div> : null}
    </div>
  );
}
