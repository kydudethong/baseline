"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CalendarSession } from "@/lib/db/practice-calendar";
import { calendarGrid } from "@/lib/practice/schedule";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A month of practice, as a month.
 *
 * WHY A GRID AND NOT A LIST. A list of twelve sessions answers "what should I
 * do" and not "am I keeping up", and keeping up is the entire reason this
 * feature exists. Seeing three ticked squares and a gap where last week was is
 * a different feeling from reading "4 of 12 complete", and it is the feeling
 * that gets somebody onto a court.
 *
 * Ticks post immediately and optimistically. A checkbox that waits on a round
 * trip before it moves feels broken, and the cost of being wrong is one
 * unticked box after the refresh -- not lost work.
 */
export function CalendarMonth({
  month,
  sessions: initial,
}: {
  /** Any date inside the month, as YYYY-MM-DD. */
  month: string;
  sessions: CalendarSession[];
}) {
  const router = useRouter();
  const [sessions, setSessions] = useState(initial);
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const weeks = calendarGrid(new Date(`${month}T12:00:00`));
  const byDate = new Map(sessions.map((s) => [s.scheduled_on, s]));
  const open = openDate ? byDate.get(openDate) ?? null : null;

  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const doneCount = sessions.filter((s) => s.completed_at).length;

  /**
   * Consecutive finished sessions counting back from the most recent one that
   * has happened.
   *
   * COUNTED BACKWARDS FROM THE LAST SESSION THAT IS DUE, not from the end of
   * the month: every session still in the future is unfinished by definition,
   * and counting those would report a broken streak to somebody who has not
   * missed anything. A session scheduled for Friday is not a gap on Tuesday.
   */
  const streak = (() => {
    const past = [...sessions]
      .filter((s) => s.scheduled_on <= todayKey)
      .sort((a, b) => b.scheduled_on.localeCompare(a.scheduled_on));
    let n = 0;
    for (const s of past) {
      if (!s.completed_at) break;
      n += 1;
    }
    return n;
  })();

  async function tick(kind: "session" | "drill", id: string, done: boolean) {
    setSessions((prev) =>
      prev.map((s) => {
        if (kind === "session" && s.id === id) {
          return { ...s, completed_at: done ? new Date().toISOString() : null };
        }
        if (kind === "drill") {
          return {
            ...s,
            drills: s.drills.map((d) =>
              d.id === id ? { ...d, completed_at: done ? new Date().toISOString() : null } : d
            ),
          };
        }
        return s;
      })
    );
    try {
      const res = await fetch("/api/practice/tick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, id, done }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Couldn't save that.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that.");
      router.refresh();
    }
  }

  async function helped(sessionId: string, value: number) {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, helped: value } : s)));
    try {
      const res = await fetch("/api/practice/tick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "session", id: sessionId, done: true, helped: value }),
      });
      if (!res.ok) throw new Error("save failed");
      router.refresh();
    } catch {
      setError("Couldn't save that.");
    }
  }

  return (
    <div className="stack g4">
      {/* THE HEADER IS THE MOTIVATION, so it stopped being a grey pill.
          "4 of 12 done" is a fact; a bar a third full is a feeling, and the
          feeling is what gets somebody onto a court on Tuesday. The streak
          only appears when there IS one -- a badge reading "0 in a row" is a
          reminder of failure printed in a colour reserved for good news. */}
      <div className="cal-top">
        <div className="cal-stats">
          <span className="cal-count">
            {doneCount}<em> / {sessions.length}</em>
          </span>
          <span className="cal-caption">
            {doneCount === 0
              ? "sessions this month — the first one is the hard one"
              : doneCount === sessions.length
                ? "every session done. That is a whole month."
                : `sessions done · ${sessions.length - doneCount} to go`}
          </span>
          {streak >= 2 ? (
            <span className="cal-streak">🔥 {streak} in a row</span>
          ) : null}
        </div>
        <div
          className="cal-bar"
          role="progressbar"
          aria-valuenow={doneCount}
          aria-valuemin={0}
          aria-valuemax={sessions.length}
          aria-label={`${doneCount} of ${sessions.length} sessions done`}
        >
          <div
            className="cal-bar-fill"
            style={{ width: sessions.length ? `${(doneCount / sessions.length) * 100}%` : "0%" }}
          />
        </div>
        {error ? <span className="xs" style={{ color: "var(--bad)" }}>{error}</span> : null}
      </div>

      <div className="cal">
        <div className="cal-head">
          {DAY_NAMES.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
        {weeks.map((week, wi) => (
          <div key={wi} className="cal-week">
            {week.map((date, di) => {
              if (!date) return <div key={di} className="cal-day empty" />;
              const session = byDate.get(date);
              const done = Boolean(session?.completed_at);
              return (
                <button
                  key={di}
                  type="button"
                  className={`cal-day${session ? " has" : ""}${done ? " done" : ""}${date === todayKey ? " today" : ""}${openDate === date ? " open" : ""}`}
                  onClick={() => setOpenDate(session ? (openDate === date ? null : date) : null)}
                  disabled={!session}
                  aria-label={session ? `${date}: ${session.title}` : date}
                >
                  <span className="n">{Number(date.slice(-2))}</span>
                  {session ? <span className="t">{session.title}</span> : null}
                  {done ? <span className="tick">✓</span> : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {open ? (
        <article className="card stack g3">
          <div className="row g3">
            <div className="stack g1">
              <span className="eyebrow">
                {new Date(`${open.scheduled_on}T12:00:00`).toLocaleDateString(undefined, {
                  weekday: "long", month: "long", day: "numeric",
                })}
              </span>
              <p className="h3" style={{ margin: 0 }}>{open.title}</p>
              {open.focus ? <p className="sm" style={{ margin: 0 }}>{open.focus}</p> : null}
            </div>
            <button
              type="button"
              className={`btn btn-sm mla ${open.completed_at ? "btn-soft" : "btn-optic"}`}
              onClick={() => tick("session", open.id, !open.completed_at)}
            >
              {open.completed_at ? "Done ✓ — undo" : "Mark session done"}
            </button>
          </div>

          {/* Only after it is done, and only then. Asking "did this help?"
              about a session somebody has not run yet is noise, and a control
              that appears the moment they tick it off is asked at the one
              moment they actually know. */}
          {open.completed_at ? (
            <div className="fb">
              <div className="fb-row">
                <span className="fb-q">Did this session help?</span>
                {([
                  { v: 1, label: "Yes" },
                  { v: 0, label: "Too early to tell" },
                  { v: -1, label: "Not really" },
                ] as const).map((o) => (
                  <button
                    key={o.v}
                    type="button"
                    className={`fb-btn${open.helped === o.v ? (o.v === 1 ? " on good" : o.v === -1 ? " on bad" : " on") : ""}`}
                    onClick={() => helped(open.id, o.v)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="stack g2">
            {open.drills.map((d) => (
              <label key={d.id} className={`drill-row${d.completed_at ? " done" : ""}`}>
                <input
                  type="checkbox"
                  checked={Boolean(d.completed_at)}
                  onChange={(e) => tick("drill", d.id, e.target.checked)}
                />
                <span className="stack g1">
                  <span className="nm">
                    {d.name}
                    {d.minutes ? <span className="mins"> · {d.minutes} min</span> : null}
                  </span>
                  {d.how ? <span className="how">{d.how}</span> : null}
                  {d.success ? <span className="succ"><strong>Stop when:</strong> {d.success}</span> : null}
                </span>
              </label>
            ))}
          </div>
        </article>
      ) : (
        <p className="note">
          Tap a highlighted day to see its drills and tick them off. The dashed squares are rest —
          a month where every square is full is a month nobody finishes.
        </p>
      )}
    </div>
  );
}
