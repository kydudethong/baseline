/**
 * How much gameplay a month an account may analyse.
 *
 * MINUTES, NOT GAMES, because minutes are what things cost. A run is billed by
 * how much video Gemini watches -- roughly six cents a minute at the current
 * settings -- so three games meant anything from twelve minutes to ninety
 * depending on how long somebody's clips happened to be, and the same
 * allowance could cost five times as much for one user as another. Counting
 * the thing that costs money makes the limit mean one thing for everybody.
 *
 * THE GATE IS ON PROCESSING, NOT UPLOADING. An upload costs pennies of
 * storage; a run costs real money. So an upload is always free, and somebody
 * can upload a clip, look at the setup screen, decide the camera angle was
 * wrong and delete it, without having spent any of their month.
 *
 * RE-RUNNING A CLIP IS FREE. This is the difference between a quota and a
 * trap: a run that failed, or one re-analysed after fixing the court or
 * re-tagging the wrong player, is the same footage. Charging twice would leave
 * somebody out of minutes with a bad court and no way to fix it -- exactly
 * when they most need the re-run.
 */

/**
 * Minutes of gameplay a month on the FREE plan: a taste, not a game.
 *
 * Ten, by decision. A full recreational game runs 12-20 minutes, so a free
 * account reads a ten-minute STRETCH of one -- enough to see what the read is
 * and what it finds, and short of what somebody who plays weekly needs.
 * Anything longer is refused with an offer of the plan, and the refusal says
 * trimming works too (see clipExceedsWholeAllowance on the process route).
 *
 * Still counted in MINUTES rather than as "one analysis", because a clip is
 * anything from five minutes to forty and minutes are what a read costs.
 */
export const MINUTES_PER_MONTH = 10;

/**
 * The paid plan: 90 minutes a month, about six games.
 *
 * Priced in Stripe, not here -- this is only the allowance the price buys. At
 * roughly 6.6 cents a minute all-in, a fully used month costs about $6 against
 * $20, and most people will not use all of it.
 */
export const PRO_MINUTES_PER_MONTH = 90;

/**
 * What this account has paid for, as Stripe reports it.
 *
 * ONE PLAN, so this is a single fact. It was a plan plus a list of games
 * bought one at a time; the one-off game was dropped, and its machinery with
 * it rather than left behind unreachable.
 *
 * Read from Stripe at the moment of asking rather than copied into a table:
 * no migration, no webhook to miss, and no second copy of "is this person
 * paying" that can disagree with the one that actually charges them.
 */
export interface Entitlement {
  plan: "free" | "pro";
}

export const FREE_ENTITLEMENT: Entitlement = { plan: "free" };

export function monthlyLimitMinutes(): number {
  const v = Number(process.env.ANALYSIS_MINUTES_PER_MONTH);
  // A typo in a secret must not mean "nobody may analyse anything".
  return Number.isFinite(v) && v > 0 ? v : MINUTES_PER_MONTH;
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
 * When the plans become real this belongs in the database.
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
  /** Minutes of gameplay already analysed this month. */
  usedMinutes: number;
  limitMinutes: number;
  /** Minutes left, floored at zero. */
  remainingMinutes: number;
  /** Whether the run being asked about may go ahead. */
  allowed: boolean;
  /**
   * Set when the clip is refused because it is longer than the WHOLE monthly
   * allowance, which is a different problem with a different fix: waiting for
   * the reset will not help, and trimming the clip will.
   */
  clipExceedsWholeAllowance: boolean;
  resetsAt: string;
  plan: "free" | "pro";
}

export interface StartedRun {
  analysisId: string;
  minutes: number;
}

/**
 * Decide from what this user has already started this month.
 *
 * Split from the query so the rule can be tested without a database.
 */
export function quotaFor(opts: {
  startedThisMonth: readonly StartedRun[];
  /** The run being asked about. Null minutes means the duration is unknown. */
  analysisId: string;
  minutes: number | null;
  email: string | null | undefined;
  /** What they have paid for. Omitted means free. */
  entitlement?: Entitlement;
  now?: Date;
}): QuotaState {
  const ent = opts.entitlement ?? FREE_ENTITLEMENT;
  const limitMinutes = ent.plan === "pro" ? PRO_MINUTES_PER_MONTH : monthlyLimitMinutes();
  const resetsAt = monthEnd(opts.now).toISOString();

  // One entry per analysis, so a clip started three times is counted once.
  const byId = new Map<string, number>();
  for (const r of opts.startedThisMonth) byId.set(r.analysisId, r.minutes);
  const usedMinutes = Math.round([...byId.values()].reduce((a, b) => a + b, 0) * 10) / 10;
  const remainingMinutes = Math.max(0, Math.round((limitMinutes - usedMinutes) * 10) / 10);

  const base = {
    usedMinutes, limitMinutes, remainingMinutes, resetsAt,
    clipExceedsWholeAllowance: false, plan: ent.plan,
  };
  if (isUnlimited(opts.email)) return { ...base, unlimited: true, allowed: true };


  // A re-run is already paid for. Checked by id rather than by arithmetic, so
  // it holds when the account is exactly out of minutes -- which is the only
  // time it matters.
  if (opts.startedThisMonth.some((r) => r.analysisId === opts.analysisId)) {
    return { ...base, unlimited: false, allowed: true };
  }

  // A duration we never recorded is our missing metadata, not the user's
  // fault. Letting it through is the lesser error: refusing a run because of
  // our own gap punishes somebody for a bug they cannot see, and the exploit
  // requires deliberately breaking the upload.
  if (opts.minutes === null) return { ...base, unlimited: false, allowed: true };

  return {
    ...base,
    unlimited: false,
    allowed: usedMinutes + opts.minutes <= limitMinutes,
    clipExceedsWholeAllowance: opts.minutes > limitMinutes,
  };
}

/* ------------------------------------------------------------------ */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * This user's quota, read from what they have actually started this month.
 *
 * "STARTED" MEANS THE STATUS LEFT `uploaded`. A clip sitting in the account
 * that nobody ever analysed takes nothing; one that failed halfway does,
 * because the money was spent either way and pretending otherwise turns a
 * retry loop into a real bill.
 */
export async function quotaForUser(
  supabase: SupabaseClient,
  userId: string,
  email: string | null | undefined,
  analysisId: string,
  /** Length of the clip about to run; null when it is not known. */
  minutes: number | null,
  entitlement: Entitlement = FREE_ENTITLEMENT
): Promise<QuotaState> {
  const { data, error } = await supabase
    .from("analyses")
    .select("id, videos(duration_seconds)")
    .eq("user_id", userId)
    .neq("status", "uploaded")
    .gte("created_at", monthStart().toISOString());
  if (error) throw error;

  const rows = (data ?? []) as Array<{
    id: string;
    videos: { duration_seconds: number | null } | Array<{ duration_seconds: number | null }> | null;
  }>;
  const started: StartedRun[] = rows.map((r) => {
    // Supabase returns an embedded one-to-one as an object or a one-element
    // array depending on how the relationship is declared; handle both rather
    // than depending on which.
    const v = Array.isArray(r.videos) ? r.videos[0] : r.videos;
    const secs = v?.duration_seconds ?? null;
    return { analysisId: r.id, minutes: secs === null ? 0 : secs / 60 };
  });
  return quotaFor({ startedThisMonth: started, analysisId, minutes, email, entitlement });
}
