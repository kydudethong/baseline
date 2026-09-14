import Link from "next/link";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import {
  completedGameCount, getPracticeMonth, weaknessesForUser, UNLOCK_AT_GAMES,
} from "@/lib/db/practice-calendar";
import { monthKey } from "@/lib/practice/schedule";
import { CalendarMonth } from "@/components/practice/CalendarMonth";
import { PlanSetup } from "@/components/practice/PlanSetup";
import { UpNext } from "@/components/practice/UpNext";
import { EmptyState } from "@/components/analysis/EmptyState";

export const metadata: Metadata = { title: "Practice calendar — Baseline" };
export const dynamic = "force-dynamic";

/**
 * A month of practice, built from what the player's games actually showed.
 *
 * GATED AT THREE GAMES, and the gate is honest about why rather than dangling
 * a locked feature: one clip is one afternoon, and a month of drills built on
 * a single bad day sends somebody to work on a weakness they do not have. The
 * page says that, and says how many more games it needs.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams?: Promise<{ month?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return (
      <div className="sec">
        <EmptyState title="Sign in to see your practice calendar" body="Your month of practice is tied to your games." />
      </div>
    );
  }

  const games = await completedGameCount(supabase, user.id);
  const requested = (await searchParams)?.month;
  const month = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : monthKey(new Date());
  const monthDate = new Date(`${month}T12:00:00`);
  const monthLabel = monthDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  if (games < UNLOCK_AT_GAMES) {
    const left = UNLOCK_AT_GAMES - games;
    return (
      <div className="sec">
        <div className="sec-head">
          <div className="stack g1">
            <span className="eyebrow">Practice calendar</span>
            <h1 className="h1">A month of practice, built from your own games</h1>
          </div>
        </div>
        <div className="card stack g3">
          <p className="body measure">
            Baseline needs <strong>{UNLOCK_AT_GAMES} analysed games</strong> before it builds you a
            month. You have {games}.
          </p>
          <p className="sm measure">
            Not an arbitrary number: one clip is one afternoon. A weakness that shows up in a single
            game might be the weakness, or might be that you were tired and the lighting was bad —
            and a month of drilling the wrong thing is a month wasted. Three games is where a
            pattern starts being a pattern.
          </p>
          <div className="progress" style={{ maxWidth: 320 }}>
            <div className="bar" style={{ width: `${(games / UNLOCK_AT_GAMES) * 100}%` }} />
          </div>
          <p className="xs">
            {left} more {left === 1 ? "game" : "games"} to go.
          </p>
          <div className="row g2">
            <Link href="/dashboard/new" className="btn btn-optic">+ Analyze a game</Link>
            <Link href="/dashboard/practice" className="btn btn-soft">See your skill trends</Link>
          </div>
        </div>
      </div>
    );
  }

  const [existing, { weaknesses }] = await Promise.all([
    getPracticeMonth(supabase, user.id, month),
    weaknessesForUser(supabase, user.id, 4),
  ]);
  const completedCount = existing?.sessions.filter((s) => s.completed_at).length ?? 0;

  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const prev = shiftMonth(monthDate, -1);
  const next = shiftMonth(monthDate, 1);

  return (
    <div className="sec">
      <div className="sec-head">
        <div className="stack g1">
          <span className="eyebrow">Practice calendar</span>
          <h1 className="h1">{monthLabel}</h1>
          <p className="sm">
            {existing?.plan.focus ?? "Built from the weaknesses your last few games showed."}
          </p>
        </div>
        <div className="row g2 mla">
          <Link href={`/dashboard/calendar?month=${prev}`} className="btn btn-soft btn-sm">← Previous</Link>
          <Link href={`/dashboard/calendar?month=${next}`} className="btn btn-soft btn-sm">Next →</Link>
        </div>
      </div>

      {existing && existing.sessions.length > 0 ? (
        <div className="stack g5">
          {existing.plan.targets.length > 0 ? (
            <div className="row g2">
              <span className="xs" style={{ color: "var(--ink-3)" }}>This month is answering:</span>
              {existing.plan.targets.map((t) => (
                <span key={t} className="pill p-warn">{t}</span>
              ))}
            </div>
          ) : null}

          {/* Grid and "what do I do next" side by side. The grid answers "am I
              keeping up"; only the panel answers "what do I do today", and
              making somebody find today's square to learn that is three steps
              too many for the question they opened this page with. */}
          <div className="cal-layout">
            <CalendarMonth month={month} sessions={existing.sessions} />
            <UpNext sessions={existing.sessions} todayKey={todayKey} />
          </div>

          <details className="card">
            <summary className="sm" style={{ cursor: "pointer" }}>Change the schedule or rebuild this month</summary>
            <div style={{ marginTop: 16 }}>
              <PlanSetup
                month={month}
                monthLabel={monthLabel}
                initialDays={existing.plan.play_days}
                initialSessions={existing.plan.sessions_per_month ?? 8}
                hasExistingPlan
                completedCount={completedCount}
              />
            </div>
          </details>
        </div>
      ) : (
        <div className="stack g4">
          {weaknesses.length > 0 ? (
            <div className="note">
              <strong style={{ color: "var(--ink)" }}>What your games have been showing:</strong>
              <ul style={{ marginTop: 6, paddingLeft: 18, listStyle: "disc" }}>
                {weaknesses.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              A month built now will be aimed at these.
            </div>
          ) : null}
          <PlanSetup
            month={month}
            monthLabel={monthLabel}
            initialDays={[2, 6]}
            initialSessions={8}
            hasExistingPlan={false}
            completedCount={0}
          />
        </div>
      )}
    </div>
  );
}

/** First day of the month `delta` months from `date`, as YYYY-MM-DD. */
function shiftMonth(date: Date, delta: number): string {
  return monthKey(new Date(date.getFullYear(), date.getMonth() + delta, 1));
}
