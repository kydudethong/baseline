import { NextResponse } from "next/server";

import { createServiceRoleClient } from "@/lib/supabase/server";
import { digestEmail, type DigestSkill } from "@/lib/notify/digest-email";
import { emailConfigured, sendEmail } from "@/lib/notify/send";
import { skillName } from "@/lib/coaching/types";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The weekly digest, for whatever wants to run it once a week.
 *
 * A ROUTE RATHER THAN A SCHEDULER. This app is one long-lived container (see
 * docs/deploy.md) and an in-process timer in it would fire on every redeploy,
 * never on a machine that restarted, and nowhere at all if the box is asleep.
 * A URL with a secret can be called by anything -- a Fly scheduled machine, a
 * GitHub Action, cron on a laptop -- and can be tested by curling it.
 *
 * GUARDED BY A SECRET, not by a session: nobody is logged in when a scheduler
 * calls this. Without DIGEST_TOKEN set it refuses everything, because a
 * route that emails every user on the system is not one to leave open by
 * default.
 *
 * `?dry=1` reports what it would send without sending it, which is how to
 * check the wording against real accounts before turning the schedule on.
 */
export async function POST(request: Request) {
  const token = process.env.DIGEST_TOKEN?.trim();
  if (!token) {
    return NextResponse.json({ error: "DIGEST_TOKEN is not set, so the digest is off." }, { status: 503 });
  }
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim()
    ?? new URL(request.url).searchParams.get("token");
  if (given !== token) return NextResponse.json({ error: "Not authorised" }, { status: 401 });

  const dry = new URL(request.url).searchParams.get("dry") === "1";
  if (!dry && !emailConfigured()) {
    return NextResponse.json({ error: "RESEND_API_KEY and EMAIL_FROM are not both set." }, { status: 503 });
  }

  const supabase = createServiceRoleClient();
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  // Everything analysed in the window, with the ratings those reads produced.
  const { data: rows, error } = await supabase
    .from("analyses")
    .select("id, user_id, created_at, videos(duration_seconds), coaching_reads(headline), coaching_skill_ratings(skill_key, raw)")
    .gte("created_at", since)
    .eq("status", "completed");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Row = {
    id: string; user_id: string; created_at: string;
    videos?: { duration_seconds?: number | null } | null;
    coaching_reads?: { headline?: string | null } | Array<{ headline?: string | null }> | null;
    coaching_skill_ratings?: Array<{ skill_key: string; raw: number | null }> | null;
  };
  const byUser = new Map<string, Row[]>();
  for (const r of (rows ?? []) as Row[]) {
    const list = byUser.get(r.user_id);
    if (list) list.push(r);
    else byUser.set(r.user_id, [r]);
  }

  const results: Array<{ userId: string; subject: string | null; sent: boolean }> = [];
  for (const [userId, theirs] of byUser) {
    theirs.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const latest = theirs[theirs.length - 1];
    const previous = theirs.length > 1 ? theirs[theirs.length - 2] : null;

    const ratingsOf = (r: Row | null) => new Map(
      (r?.coaching_skill_ratings ?? [])
        .filter((s) => Number.isFinite(Number(s.raw)))
        .map((s) => [s.skill_key, Number(s.raw)] as const)
    );
    const now = ratingsOf(latest);
    const before = ratingsOf(previous);
    const moved: DigestSkill[] = [...now.entries()].map(([key, value]) => ({
      name: skillName(key),
      now: value,
      before: before.get(key) ?? null,
    }));

    const head = Array.isArray(latest.coaching_reads)
      ? latest.coaching_reads[0]?.headline ?? null
      : latest.coaching_reads?.headline ?? null;

    const content = digestEmail({
      gamesThisWeek: theirs.length,
      minutesThisWeek: Math.round(
        theirs.reduce((sum, r) => sum + Number(r.videos?.duration_seconds ?? 0), 0) / 60
      ),
      topFix: head,
      moved,
      drill: null,
      url: `${env.siteUrl.replace(/\/+$/, "")}/dashboard/practice`,
    });
    if (!content) continue;

    if (dry) {
      results.push({ userId, subject: content.subject, sent: false });
      continue;
    }
    const { data: userRes } = await supabase.auth.admin.getUserById(userId);
    const to = userRes?.user?.email;
    if (!to) continue;
    const sent = await sendEmail(to, content);
    results.push({ userId, subject: content.subject, sent });
  }

  return NextResponse.json({
    window: { since, days: 7 },
    accounts: byUser.size,
    emails: results.length,
    dry,
    results: dry ? results : results.map((r) => ({ sent: r.sent })),
  });
}
