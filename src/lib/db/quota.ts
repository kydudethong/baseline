/**
 * How many games a month an account may analyse.
 *
 * THE GATE IS ON PROCESSING, NOT UPLOADING. Uploading costs a few cents of
 * storage; analysing costs real money at Gemini, about a dollar twenty for a
 * twenty-minute game. So an upload is always free and the count is of games
 * actually analysed -- which also means somebody can upload, look at the setup
 * screen, decide the camera angle was wrong and delete it, without having paid
 * for anything.
 *
 * RE-RUNNING A GAME IS FREE. This is not generosity, it is the difference
 * between a quota and a trap: a run that failed, or one re-analysed after
 * fixing the court or re-tagging the wrong player, is the SAME game. Charging
 * for it would mean a user with three games and one bad court has two games
 * left and no way to fix the first. The count is of distinct analyses started
 * this month, so the second run of one of them changes nothing.
 */

/** Games a month on the default plan. */
export const ANALYSES_PER_MONTH = 3;

export function monthlyLimit(): number {
  const v = Number(process.env.ANALYSES_PER_MONTH);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : ANALYSES_PER_MONTH;
}

/**
 * Accounts with no limit at all, by email.
 *
 * AN ENV VAR RATHER THAN A COLUMN, deliberately and for one concrete reason:
 * this repo's CI only applies migrations when RUN_MIGRATIONS is set, and it is
 * not. A `profiles.unlimited` column would therefore ship as code reading a
 * column that does not exist, and the first thing anybody saw would be a 500
 * on upload. A secret can be set on the running app in one command.
 *
 * When the plans become real this belongs in the database. Until then the
 * honest version is the one that works.
 */
export function unlimitedEmails(): string[] {
  return (process.env.UNLIMITED_ANALYSIS_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isUnlimited(email: string | null | undefined): boolean {
  if (!email) return false;
  return unlimitedEmails().includes(email.trim().toLowerCase());
}

/** The first instant of the current month, UTC. Quotas reset on the 1st. */
export function monthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The first instant of next month — what a user is told to wait for. */
export function monthEnd(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export interface QuotaState {
  unlimited: boolean;
  /** Distinct games analysed so far this month. */
  used: number;
  limit: number;
  /** Whether the run being asked about may go ahead. */
  allowed: boolean;
  /** When the count goes back to zero. */
  resetsAt: string;
}

/**
 * Decide from a list of this month's already-started analyses.
 *
 * Split from the query so the rule can be tested without a database. The
 * caller passes the ids of analyses this user has ALREADY started processing
 * this month, plus the id of the one being asked about.
 */
export function quotaFor(opts: {
  startedThisMonth: readonly string[];
  /** The analysis about to run. Already in the list means this is a re-run. */
  analysisId: string;
  email: string | null | undefined;
  now?: Date;
}): QuotaState {
  const limit = monthlyLimit();
  const resetsAt = monthEnd(opts.now).toISOString();
  if (isUnlimited(opts.email)) {
    return { unlimited: true, used: opts.startedThisMonth.length, limit, allowed: true, resetsAt };
  }
  const distinct = new Set(opts.startedThisMonth);
  const used = distinct.size;
  // A re-run of a game already counted takes no new slot. Checked by id rather
  // than by count, so it holds even at exactly the limit -- which is the case
  // that matters, since that is when somebody needs to fix a bad court.
  const isRerun = distinct.has(opts.analysisId);
  return { unlimited: false, used, limit, allowed: isRerun || used < limit, resetsAt };
}

/* ------------------------------------------------------------------ */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * This user's quota, read from what they have actually started this month.
 *
 * "STARTED" MEANS THE STATUS LEFT `uploaded`. A clip sitting in the account
 * that nobody ever analysed costs pennies of storage and takes no slot; one
 * that failed halfway does take a slot, because the money was spent either
 * way and pretending otherwise would let a retry loop run up a real bill.
 */
export async function quotaForUser(
  supabase: SupabaseClient,
  userId: string,
  email: string | null | undefined,
  analysisId: string
): Promise<QuotaState> {
  const { data, error } = await supabase
    .from("analyses")
    .select("id")
    .eq("user_id", userId)
    .neq("status", "uploaded")
    .gte("created_at", monthStart().toISOString());
  if (error) throw error;
  return quotaFor({
    startedThisMonth: ((data ?? []) as Array<{ id: string }>).map((r) => r.id),
    analysisId,
    email,
  });
}
