import Link from "next/link";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { listAnalysisSummariesForUser, listAnalysesForUser } from "@/lib/db/analyses";
import { getSignedDownloadUrl } from "@/lib/storage/r2";
import { getRankedWeaknesses, getSkillProfiles, overallRating } from "@/lib/coaching/stats";
import { quotaForUser } from "@/lib/db/quota";
import { entitlementFor, planPriceLabel, stripeConfigured } from "@/lib/billing/stripe";
import { BillingButton } from "@/components/billing/BillingButton";
import { getProfile } from "@/lib/db/profiles";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { PlayIcon } from "@/components/motifs/Motifs";
import { EmptyState } from "@/components/analysis/EmptyState";
import { clock } from "@/lib/format/duration";

export const metadata: Metadata = { title: "Home — Baseline" };
export const dynamic = "force-dynamic";

/**
 * Home: a greeting, a row of counts, the last clip you analysed, and the three
 * things people actually come here to start.
 *
 * What is NOT here, deliberately: an "average improvement" percentage and an
 * overall rating. Nothing in this pipeline computes either — skills are rated
 * 1–5 individually, per clip, only where the data supports it, and nothing
 * measures session-over-session change. A tile that looks like a score but is
 * invented would undo the one promise the rest of the product keeps. Every
 * tile below is a count of something real.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<{ billing?: string }>;
}) {
  // Back from Stripe's success page: ask Stripe again rather than trust a
  // cached "free" from thirty seconds before they paid.
  const justPaid = (await searchParams)?.billing === "success";
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null; // layout already redirects unauthenticated requests

  const [analyses, profile] = await Promise.all([
    listAnalysisSummariesForUser(supabase, user.id),
    getProfile(supabase, user.id),
  ]);
  const completedCount = analyses.filter((a) => a.status === "completed").length;
  const inFlightCount = analyses.filter((a) => a.status === "queued" || a.status === "processing").length;
  const weaknesses = completedCount > 0 ? await getRankedWeaknesses(supabase, user.id, 3) : [];
  const overall = completedCount > 0
    ? overallRating(await getSkillProfiles(supabase, user.id))
    : { rating: null, games: 0, skills: 0 };
  // SHOWN BEFORE THE UPLOAD, not after it. The gate itself lives on the
  // process route, which is where the money is; finding out you are out of
  // games only once a 500MB clip has finished uploading would be a bad way to
  // learn it.
  // Cached for thirty seconds inside entitlementFor, so this is not a Stripe
  // call per page view. On error it reads as free, which here only affects
  // the number shown -- the run gate makes its own, more generous call.
  const { entitlement } = await entitlementFor(user.id, user.email, { fresh: justPaid });
  const quota = await quotaForUser(supabase, user.id, user.email, "", null, entitlement);
  const billing = stripeConfigured() && !quota.unlimited
    ? { plan: quota.plan, planPrice: await planPriceLabel() }
    : null;

  if (analyses.length === 0) {
    return (
      <div className="sec">
        <div className="greet">
          <span className="eyebrow">Home</span>
          <h1>Let&apos;s break down your first game</h1>
        </div>
        <EmptyState
          title="Nothing analyzed yet"
          body="Upload a recording of a match and Baseline will find every rally and every paddle contact, then tell you the one change worth making."
          action={<Link href="/dashboard/new" className="btn btn-optic">Analyze your first game</Link>}
        />
      </div>
    );
  }

  // The most recent COMPLETED clip, not merely the most recent — a still
  // processing upload has nothing to show and nothing to open.
  const full = await listAnalysesForUser(supabase, user.id);
  const latest = full.find((a) => a.status === "completed") ?? null;
  const latestUrl = latest?.video
    ? await getSignedDownloadUrl(latest.video.storage_path).catch(() => null)
    : null;

  return (
    <>
      <div className="greet">
        <h1>{greeting()}, {firstName(profile?.display_name, user.email)}</h1>
        <p className="sm">
          {completedCount > 0
            ? `${completedCount} game${completedCount === 1 ? "" : "s"} broken down so far.`
            : "Your first breakdown is on its way."}
          {/* THE NUMBER BELONGS WHERE THE PLAYER LANDS. It is the one thing
              they want to know on opening the app -- am I getting better --
              and it was computable from ratings that already existed and shown
              nowhere. Still carrying its sample size, because without that it
              is a score rather than a reading. */}
          {!quota.unlimited ? (
            <>
              {" "}
              <span style={{ opacity: 0.7 }}>
                {Math.round(quota.remainingMinutes)} of {Math.round(quota.limitMinutes)} minutes
                left this month{quota.plan === "free" ? " on the free plan" : ""}.
              </span>
              {billing ? (
                <>
                  {" "}
                  <BillingButton plan={billing.plan} planPrice={billing.planPrice} />
                </>
              ) : null}
            </>
          ) : null}
          {overall.rating !== null ? (
            <>
              {" "}Overall <strong>{overall.rating.toFixed(1)}/5</strong>{" "}
              <span style={{ opacity: 0.7 }}>
                across {overall.games} game{overall.games === 1 ? "" : "s"}
              </span>.{" "}
              <Link href="/dashboard/practice" style={{ color: "var(--blue)" }}>See the breakdown</Link>
            </>
          ) : null}
        </p>
      </div>

      {/* Gradient tiles, same component as the analysis page. Only the first
          gets a ring, because only the first is a fraction of something: how
          many uploads made it all the way to a breakdown. The other three are
          counts, and a ring on a count would have to invent the denominator. */}
      <div className="gtiles">
        <article className="gtile hue-1">
          <div className="gtile-txt">
            <p className="gtile-v">{completedCount}</p>
            <p className="gtile-l">Breakdowns ready</p>
            <p className="gtile-c">
              {analyses.length} game{analyses.length === 1 ? "" : "s"} uploaded
            </p>
          </div>
          {analyses.length > 0 ? (
            <div className="gtile-ring">
              <svg viewBox="0 0 44 44" aria-hidden="true">
                <circle className="tr" cx="22" cy="22" r="19" />
                <circle
                  className="tv" cx="22" cy="22" r="19"
                  strokeDasharray={`${(2 * Math.PI * 19) * (completedCount / analyses.length)} ${2 * Math.PI * 19}`}
                  transform="rotate(-90 22 22)"
                />
              </svg>
              <span className="gtile-ring-n">
                {Math.round((completedCount / analyses.length) * 100)}
              </span>
            </div>
          ) : null}
        </article>

        <article className="gtile hue-2">
          <div className="gtile-txt">
            <p className="gtile-v">{inFlightCount || "\u2014"}</p>
            <p className="gtile-l">Processing</p>
            <p className="gtile-c">{inFlightCount ? "running right now" : "nothing in the queue"}</p>
          </div>
        </article>

        <article className="gtile hue-3">
          <div className="gtile-txt">
            <p className="gtile-v">{weaknesses.length || "\u2014"}</p>
            <p className="gtile-l">Recurring weaknesses</p>
            <p className="gtile-c">
              {weaknesses.length ? "seen across more than one game" : "not enough games yet"}
            </p>
          </div>
        </article>

        <article className="gtile hue-4">
          <div className="gtile-txt">
            <p className="gtile-v">{analyses.length}</p>
            <p className="gtile-l">Games uploaded</p>
            <p className="gtile-c">everything in your library</p>
          </div>
        </article>
      </div>

      {latest ? (
        <section className="sec">
          <div className="sec-head"><h2 className="h2">Latest analysis</h2></div>
          <div className="latest">
            <Link href={`/dashboard/${latest.id}`} className="latest-thumb" aria-label={`Open ${latest.title}`}>
              {latestUrl ? <video src={`${latestUrl}#t=2`} muted playsInline preload="metadata" /> : null}
              <span className="latest-play"><PlayIcon size={17} /></span>
            </Link>
            <div className="latest-body">
              <span className="eyebrow">
                {new Date(latest.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                {latest.video?.duration_seconds ? ` · ${formatDuration(latest.video.duration_seconds)}` : ""}
              </span>
              <p className="h2" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{latest.title}</p>
              <div className="row g3" style={{ marginTop: 6 }}>
                <Link href={`/dashboard/${latest.id}`} className="btn btn-optic btn-sm">View full analysis</Link>
                <StatusBadge status={latest.status} />
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <section className="sec">
        <div className="sec-head"><h2 className="h2">Quick actions</h2></div>
        <div className="qa">
          <Link href="/dashboard/new">
            <span className="ic"><PlayIcon size={20} /></span>
            <span className="t">Upload a game</span>
            <span className="d">Get a breakdown in a few minutes</span>
          </Link>
          <Link href="/dashboard/drills">
            <span className="ic"><PlayIcon size={20} /></span>
            <span className="t">Browse drills</span>
            <span className="d">The library your practice plans pull from</span>
          </Link>
          <Link href="/dashboard/practice">
            <span className="ic"><PlayIcon size={20} /></span>
            <span className="t">What to work on</span>
            <span className="d">Weaknesses that keep showing up across games</span>
          </Link>
        </div>
      </section>

      <section className="sec">
        <div className="sec-head">
          <h2 className="h2">What to work on</h2>
          {weaknesses.length > 0 ? (
            <Link href="/dashboard/practice" className="crumb mla">See your full practice plan →</Link>
          ) : null}
        </div>
        {weaknesses.length === 0 ? (
          <div className="note">
            {completedCount === 0
              ? "Once a game finishes processing, your top priorities will show up here."
              : "No recurring weaknesses found yet across your completed games — keep uploading to build a fuller picture."}
          </div>
        ) : (
          <div className="stack g3">
            {weaknesses.map((w) => (
              <div key={w.skillKey} className="weak">
                <div className="stripe" />
                <div className="in">
                  <span className="eyebrow">{w.name}</span>
                  <p className="h3">{w.mostRecent.title}</p>
                  <p className="sm">{w.mostRecent.detail}</p>
                  <div className="evid">
                    <Link href={`/dashboard/${w.mostRecent.analysisId}`}>seen in {w.mostRecent.analysisTitle}</Link>
                    {w.occurrences > 1 ? <span className="chip">shown up {w.occurrences}×</span> : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

/** Local-time greeting. Rendered on the server, so it is the SERVER's clock —
 * close enough for a salutation, and not worth a client component. */
function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** Their name if they gave one, otherwise the readable part of the email.
 * Same rule as the rail's chip, so the two never disagree. */
function firstName(displayName: string | null | undefined, email: string | undefined): string {
  if (displayName?.trim()) return displayName.trim().split(/\s+/)[0];
  const local = (email ?? "").split("@")[0] ?? "";
  const word = local.split(/[.\-_+]/)[0] ?? "";
  return word ? word[0].toUpperCase() + word.slice(1) : "there";
}

function formatDuration(seconds: number): string {
  return clock(seconds);
}
