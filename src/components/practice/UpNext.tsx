import type { CalendarSession } from "@/lib/db/practice-calendar";

/**
 * The next session, pinned beside the month.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE GRID. A month grid answers "am I keeping
 * up" and is genuinely bad at answering "what do I do today" — the reader has
 * to find today's square, work out whether it is the next one, and click it.
 * That is three steps to answer the only question somebody has when they open
 * this page on the way to a court.
 *
 * So the next unfinished session gets its own panel with the drills already
 * expanded. The grid keeps its job; this keeps the reader from having to do
 * the grid's job for it.
 *
 * "Next" means the earliest unfinished session that is not in the past, and
 * failing that the earliest unfinished one at all — a missed session is still
 * the next thing to do, and hiding it would quietly let someone skip a week
 * and see nothing about it.
 */
export function UpNext({
  sessions,
  todayKey,
}: {
  sessions: CalendarSession[];
  /** Local YYYY-MM-DD for today, passed in so the server and client agree. */
  todayKey: string;
}) {
  const unfinished = sessions.filter((s) => !s.completed_at);
  const next = unfinished.find((s) => s.scheduled_on >= todayKey) ?? unfinished[0] ?? null;

  const done = sessions.filter((s) => s.completed_at).length;
  const streak = currentStreak(sessions, todayKey);

  if (!next) {
    return (
      <aside className="upnext done">
        <span className="eyebrow">This month</span>
        <p className="h3" style={{ margin: 0 }}>All done.</p>
        <p className="sm" style={{ margin: 0 }}>
          {done} session{done === 1 ? "" : "s"} finished. Upload a game and Baseline will build next
          month around what changed.
        </p>
      </aside>
    );
  }

  const overdue = next.scheduled_on < todayKey;
  const isToday = next.scheduled_on === todayKey;

  return (
    <aside className="upnext">
      <div className="upnext-head">
        <span className="eyebrow">{overdue ? "Missed — do it next" : isToday ? "Today" : "Up next"}</span>
        <span className={`pill ${overdue ? "p-warn" : "p-good"}`}>
          {new Date(`${next.scheduled_on}T12:00:00`).toLocaleDateString(undefined, {
            weekday: "short", month: "short", day: "numeric",
          })}
        </span>
      </div>

      <p className="upnext-title">{next.title}</p>
      {next.focus ? <p className="upnext-focus">{next.focus}</p> : null}
      {next.minutes ? <p className="upnext-mins">About {next.minutes} minutes</p> : null}

      <ol className="upnext-drills">
        {next.drills.map((d) => (
          <li key={d.id} className={d.completed_at ? "done" : ""}>
            <span className="nm">{d.name}</span>
            {d.minutes ? <span className="mins">{d.minutes} min</span> : null}
            {d.success ? <span className="succ">{d.success}</span> : null}
          </li>
        ))}
      </ol>

      <div className="upnext-foot">
        <span>{done} of {sessions.length} done this month</span>
        {streak > 1 ? <span className="streak">{streak} in a row</span> : null}
      </div>
    </aside>
  );
}

/**
 * How many scheduled sessions in a row were completed, counting back from the
 * most recent one that is due.
 *
 * Counts SCHEDULED sessions, not days: a plan with two sessions a week should
 * not show a broken streak on the five days between them. Shown only at two or
 * more, because "1 in a row" is not a streak and saying it cheapens the one
 * that is.
 */
function currentStreak(sessions: CalendarSession[], todayKey: string): number {
  const due = sessions
    .filter((s) => s.scheduled_on <= todayKey)
    .sort((a, b) => (a.scheduled_on < b.scheduled_on ? 1 : -1));
  let n = 0;
  for (const s of due) {
    if (!s.completed_at) break;
    n++;
  }
  return n;
}
