import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAllDrills } from "@/lib/coaching/drills";
import { analystModel } from "@/lib/coaching/gemini";
import { buildMonthPlan } from "@/lib/practice/month-plan";
import { monthKey } from "@/lib/practice/schedule";
import { completedGameCount, weaknessesForUser, UNLOCK_AT_GAMES } from "@/lib/db/practice-calendar";
import { describeError } from "@/lib/analysis/describe-error";

export const runtime = "nodejs";

/**
 * Generate (or regenerate) one month of practice.
 *
 * REGENERATING REPLACES THE MONTH, and that is a real decision with a real
 * cost: the ticks go with it. So the UI only offers it when the player asks,
 * and the response says how many completed sessions were discarded rather than
 * letting them find out by looking.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { month?: string; playDays?: number[]; sessionsPerMonth?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const games = await completedGameCount(supabase, user.id);
  if (games < UNLOCK_AT_GAMES) {
    return NextResponse.json(
      { error: `The practice calendar opens after ${UNLOCK_AT_GAMES} analysed games. You have ${games}.` },
      { status: 403 }
    );
  }

  const month = body.month ?? monthKey(new Date());
  // Parsed at midday so a timezone offset cannot roll it into the previous
  // month -- `new Date("2026-11-01")` is UTC midnight, which is October 31st
  // anywhere west of Greenwich.
  const monthDate = new Date(`${month}T12:00:00`);
  if (Number.isNaN(monthDate.getTime())) {
    return NextResponse.json({ error: "That month isn't a date." }, { status: 400 });
  }

  const playDays = Array.isArray(body.playDays) ? body.playDays : [];
  const sessionsPerMonth = Math.max(1, Math.min(31, Math.round(body.sessionsPerMonth ?? 8)));

  try {
    const [{ weaknesses, strengths, analysisIds }, drills] = await Promise.all([
      weaknessesForUser(supabase, user.id),
      getAllDrills(supabase),
    ]);

    const plan = await buildMonthPlan({
      model: analystModel(),
      month: monthDate,
      prefs: { playDays, sessionsPerMonth },
      weaknesses,
      strengths,
      drills,
      today: new Date(),
      onLog: (l) => console.error(`[practice] ${l}`),
    });
    if (!plan) {
      return NextResponse.json(
        { error: "Couldn't build a month from this. There may be no days left in it to schedule." },
        { status: 422 }
      );
    }

    // How much progress a regeneration is about to discard, counted BEFORE the
    // delete so it can be reported honestly.
    const { data: existing } = await supabase
      .from("practice_plans")
      .select("id")
      .eq("user_id", user.id)
      .eq("month", month)
      .maybeSingle();
    let discarded = 0;
    if (existing) {
      const { data: old } = await supabase
        .from("practice_sessions")
        .select("completed_at")
        .eq("plan_id", (existing as { id: string }).id);
      discarded = (old ?? []).filter((s) => (s as { completed_at: string | null }).completed_at).length;
      // The cascade takes the sessions and their drills with it.
      await supabase.from("practice_plans").delete().eq("id", (existing as { id: string }).id);
    }

    const { data: planRow, error: planErr } = await supabase
      .from("practice_plans")
      .insert({
        user_id: user.id,
        month,
        sessions_per_month: sessionsPerMonth,
        play_days: playDays,
        focus: plan.focus,
        targets: plan.targets,
        source_analysis_ids: analysisIds,
      })
      .select()
      .single();
    if (planErr) throw planErr;

    const { data: sessionRows, error: sessErr } = await supabase
      .from("practice_sessions")
      .insert(
        plan.sessions.map((s) => ({
          plan_id: (planRow as { id: string }).id,
          scheduled_on: s.scheduledOn,
          kind: s.kind,
          title: s.title,
          focus: s.focus,
          minutes: s.minutes,
          completed_at: null,
          notes: null,
        }))
      )
      .select();
    if (sessErr) throw sessErr;

    // Sessions come back in insert order, which is the order plan.sessions was
    // built in -- but relying on that is the kind of assumption that breaks
    // silently, so they are paired by date instead.
    const byDate = new Map<string, string>();
    for (const row of (sessionRows ?? []) as Array<{ id: string; scheduled_on: string }>) {
      byDate.set(row.scheduled_on, row.id);
    }
    const drillRows = plan.sessions.flatMap((s) => {
      const sessionId = byDate.get(s.scheduledOn);
      if (!sessionId) return [];
      return s.drills.map((d) => ({
        session_id: sessionId,
        idx: d.idx,
        drill_slug: d.drillSlug,
        name: d.name,
        minutes: d.minutes,
        how: d.how,
        success: d.success,
        targets: d.targets,
        completed_at: null,
      }));
    });
    if (drillRows.length > 0) {
      const { error: drillErr } = await supabase.from("practice_session_drills").insert(drillRows);
      if (drillErr) throw drillErr;
    }

    return NextResponse.json({ ok: true, month, sessions: plan.sessions.length, discarded });
  } catch (err) {
    console.error(`[practice] month ${month} failed: ${describeError(err)}`, err);
    return NextResponse.json({ error: describeError(err) }, { status: 500 });
  }
}
