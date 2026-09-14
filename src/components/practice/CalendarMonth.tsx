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

  const doneCount = sessions.filter((s) => s.completed_at).length;
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

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

  return (
    <div className="stack g4">
      <div className="row g2">
        <span className="pill p-neutral">
          {doneCount} of {sessions.length} done
        </span>
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
          Tap a day with a session on it to see the drills and tick them off. Days without one are
          rest — a month where every square is full is a month nobody finishes.
        </p>
      )}
    </div>
  );
}
