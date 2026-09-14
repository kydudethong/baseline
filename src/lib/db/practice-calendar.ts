import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Database, PracticePlanRow, PracticeSessionRow, PracticeSessionDrillRow,
} from "./types";

type Client = SupabaseClient<Database>;

/** How many finished analyses unlock the calendar. */
export const UNLOCK_AT_GAMES = 3;

export interface CalendarSession extends PracticeSessionRow {
  drills: PracticeSessionDrillRow[];
}

export interface PracticeMonth {
  plan: PracticePlanRow;
  sessions: CalendarSession[];
}

/**
 * One month's plan with its sessions and their drills.
 *
 * Three queries rather than a nested select: the tables carry no declared FK
 * relationships in `Database` (Relationships: []), so PostgREST embedding has
 * nothing to resolve and the typed client rejects it. Three indexed lookups
 * for one month is not worth hand-writing relationship types to avoid.
 *
 * Returns null when the month has no plan, which is the ordinary state for
 * every month before the player generates one -- a thing the UI renders, not
 * an error.
 */
export async function getPracticeMonth(
  supabase: Client,
  userId: string,
  month: string
): Promise<PracticeMonth | null> {
  const { data: plan, error } = await supabase
    .from("practice_plans")
    .select("*")
    .eq("user_id", userId)
    .eq("month", month)
    .maybeSingle();
  // 42P01 = the table does not exist yet (migration not run). The practice
  // page must say so plainly rather than 500.
  if (error) {
    if (error.code === "42P01") return null;
    throw error;
  }
  if (!plan) return null;

  const { data: sessions, error: sessErr } = await supabase
    .from("practice_sessions")
    .select("*")
    .eq("plan_id", (plan as PracticePlanRow).id)
    .order("scheduled_on");
  if (sessErr) throw sessErr;

  const ids = (sessions ?? []).map((s) => (s as PracticeSessionRow).id);
  let drills: PracticeSessionDrillRow[] = [];
  if (ids.length > 0) {
    const { data, error: drillErr } = await supabase
      .from("practice_session_drills")
      .select("*")
      .in("session_id", ids)
      .order("idx");
    if (drillErr) throw drillErr;
    drills = (data ?? []) as PracticeSessionDrillRow[];
  }

  const bySession = new Map<string, PracticeSessionDrillRow[]>();
  for (const d of drills) bySession.set(d.session_id, [...(bySession.get(d.session_id) ?? []), d]);

  return {
    plan: plan as PracticePlanRow,
    sessions: ((sessions ?? []) as PracticeSessionRow[]).map((s) => ({
      ...s,
      drills: bySession.get(s.id) ?? [],
    })),
  };
}

/**
 * The weaknesses to build a month around, worst first, from the player's
 * recent analyses.
 *
 * ARCHIVED ANALYSES ARE EXCLUDED, and that is the whole point of the join: a
 * player who removes a game is saying "this one does not represent me", and a
 * calendar still drilling them on a weakness only that game showed would make
 * removing it feel like it did nothing.
 *
 * De-duplicated by the text of the issue, keeping the highest severity, so a
 * fault that appears in all three games counts once -- but its severity is the
 * worst it ever reached, not an average that softens it.
 */
export async function weaknessesForUser(
  supabase: Client,
  userId: string,
  limit = 8
): Promise<{ weaknesses: string[]; strengths: string[]; analysisIds: string[] }> {
  const { data: analyses, error } = await supabase
    .from("analyses")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "completed")
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw error;

  const ids = (analyses ?? []).map((a) => (a as { id: string }).id);
  if (ids.length === 0) return { weaknesses: [], strengths: [], analysisIds: [] };

  const { data: obs, error: obsErr } = await supabase
    .from("coaching_observations")
    .select("*")
    .in("analysis_id", ids)
    .eq("dismissed", false)
    .order("severity", { ascending: false });
  if (obsErr) throw obsErr;

  const worst = new Map<string, number>();
  const strengths: string[] = [];
  for (const o of (obs ?? []) as Array<{ issue?: string; title?: string; kind?: string; severity?: number }>) {
    const text = (o.issue ?? o.title ?? "").trim();
    if (!text) continue;
    if (o.kind === "strength") {
      if (!strengths.includes(text)) strengths.push(text);
      continue;
    }
    worst.set(text, Math.max(worst.get(text) ?? 0, o.severity ?? 0));
  }

  const weaknesses = [...worst.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([text]) => text);

  return { weaknesses, strengths: strengths.slice(0, 4), analysisIds: ids };
}

/** Finished, un-archived analyses — what the unlock counts. */
export async function completedGameCount(supabase: Client, userId: string): Promise<number> {
  const { count, error } = await supabase
    .from("analyses")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "completed")
    .is("archived_at", null);
  if (error) throw error;
  return count ?? 0;
}
