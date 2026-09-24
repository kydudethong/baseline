import Link from "next/link";
import type { Metadata } from "next";
import { SiteNav } from "@/components/marketing/SiteNav";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { Photo } from "@/components/marketing/Photo";
import { marketingAuth } from "@/components/marketing/auth";
import { PLANS, PLAN_PRICE } from "@/lib/billing/plans";
import { MINUTES_PER_MONTH, PRO_MINUTES_PER_MONTH } from "@/lib/db/quota";

export const metadata: Metadata = {
  title: "Pricing — Baseline",
  description: `${MINUTES_PER_MONTH} minutes a month free. ${PLAN_PRICE}/month for about six games.`,
};

/**
 * Two options, and the FAQ answers the questions a person has at the moment
 * of paying: what counts as a minute, what happens when I run out, can I
 * leave. Every allowance on this page comes from quota.ts -- the same
 * constants the run gate enforces -- so the page cannot promise a minute the
 * product will refuse.
 */
export default async function PricingPage() {
  const { isAuthed, startHref } = await marketingAuth();
  // Paid plans start from inside the app, where checkout knows who is buying.
  const planHref = isAuthed ? "/dashboard" : "/signup";

  return (
    <div className="mk">
      <SiteNav isAuthed={isAuthed} current="/pricing" />

      <section className="mk-hero" style={{ paddingBottom: "var(--a6)" }}>
        <div className="mk-wrap stack g3" style={{ maxWidth: 760 }}>
          <span className="mk-kicker">Pricing</span>
          <h1 className="mk-h1">One plan. Try it free first.</h1>
          <p className="mk-lead">
            Start with {MINUTES_PER_MONTH} free minutes a month to see what a read finds. When you
            want every game read, it&apos;s {PLAN_PRICE} a month. Re-running a game you&apos;ve already
            analysed is always free.
          </p>
        </div>
      </section>

      <section style={{ paddingBottom: "var(--a8)" }}>
        <div className="mk-wrap mk-prices two">
          {PLANS.map((p) => (
            <div key={p.key} className={`mk-price${p.featured ? " featured" : ""}`}>
              {p.featured ? <span className="tag">Most players</span> : null}
              <div className="stack g1">
                <strong style={{ fontSize: 18 }}>{p.name}</strong>
                <span className="sm" style={{ color: "var(--ink-3)" }}>{p.summary}</span>
              </div>
              <div className="row g2" style={{ alignItems: "baseline" }}>
                <span className="amt">{p.price}</span>
                <span className="per">{p.per}</span>
              </div>
              <ul className="mk-list">
                {p.points.map((pt) => <li key={pt}>{pt}</li>)}
              </ul>
              <Link
                href={p.key === "free" ? startHref : planHref}
                className={`btn ${p.featured ? "btn-optic" : "btn-soft"}`}
              >
                {p.cta}
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/*
        WHAT THEY ARE ACTUALLY BUYING, before the price has to be justified.
        Everything above this is a promise; a page that asks for twenty
        dollars a month and shows nothing it produces is asking to be trusted
        on the strength of its own adjectives. This is one real point out of
        one real read, in the shape the page shows it: what happened, why it
        matters, what to change, and the clip it rests on.
      */}
      <section className="mk-section">
        <div className="mk-wrap stack g4">
          <div className="stack g1">
            <span className="eyebrow">What a read looks like</span>
            <h2 className="mk-h2">One point out of one game</h2>
            <p className="mk-lead" style={{ maxWidth: 620 }}>
              Every criticism comes with the seconds of footage it came from, and every one is
              re-watched at full detail before you see it — the ones the video contradicts are
              deleted rather than softened.
            </p>
          </div>
          <div className="mk-sample">
            <div className="mk-sample-top">
              <strong>Late off the kitchen line after the return</strong>
              <span className="pill p-bad">Priority</span>
            </div>
            <div className="mk-sample-grid">
              <div className="stack g3">
                <div className="stack g1">
                  <span className="eyebrow">What happened</span>
                  <p className="sm" style={{ margin: 0 }}>
                    On four of your six returns you stopped two steps short of the kitchen and
                    played the next ball from the transition zone, at 2:14, 5:03, 8:40 and 11:22.
                  </p>
                </div>
                <div className="stack g1">
                  <span className="eyebrow">Why it matters</span>
                  <p className="sm" style={{ margin: 0 }}>
                    A ball taken below net height from mid-court has to go up. Three of those four
                    points ended with the other team volleying into your feet.
                  </p>
                </div>
                <div className="stack g1">
                  <span className="eyebrow">What to change</span>
                  <p className="sm" style={{ margin: 0 }}>
                    Keep moving through the return and split-step at the line, not before it. If
                    the ball beats you there, stop and reset rather than driving from the middle.
                  </p>
                </div>
                <div className="mk-sample-drill">
                  <span className="eyebrow">Practice</span>
                  <span>Return-and-run, 10 balls · then cross-court dinks</span>
                </div>
              </div>
              <div className="mk-sample-clip" aria-hidden="true">
                <Photo src="stock-court.jpg" alt="" ratio="16 / 10" />
                <span className="mk-sample-play">▶</span>
                <span className="mk-sample-time">2:14 — the clip this is from</span>
              </div>
            </div>
          </div>
          <p className="xs" style={{ color: "var(--ink-3)", margin: 0 }}>
            An illustration of the layout, written in the same shape as a real read. Your own read
            is about your own game, with your own footage under each point.
          </p>
        </div>
      </section>

      <section className="mk-section alt">
        <div className="mk-wrap mk-split">
          <div className="stack g4">
            <h2 className="mk-h2">Questions</h2>
            <div className="mk-faq">
              <details>
                <summary>What counts as a minute?</summary>
                <p>
                  The length of the video you analyse. A 17-minute game uses 17 minutes. Trim the
                  warm-up off before uploading and it uses less — and the read is better for it.
                </p>
              </details>
              <details>
                <summary>Can I use the free minutes on a whole game?</summary>
                <p>
                  Only a short one. {MINUTES_PER_MONTH} minutes is a stretch of most games — trim your
                  video to the part you most want read (your phone&apos;s Photos app can trim it) and
                  upload that.
                </p>
              </details>
              <details>
                <summary>What happens when I run out?</summary>
                <p>
                  Move to the monthly plan, or wait — free minutes come back on the 1st of each month.
                </p>
              </details>
              <details>
                <summary>How many games is {PRO_MINUTES_PER_MONTH} minutes?</summary>
                <p>
                  About six. Most recreational games are 12 to 20 minutes.
                </p>
              </details>
              <details>
                <summary>Does re-running a game cost minutes?</summary>
                <p>
                  No. If you fix the court lines or re-tag yourself and run it again, it&apos;s free —
                  it&apos;s the same footage.
                </p>
              </details>
              <details>
                <summary>How do I cancel?</summary>
                <p>
                  From your dashboard, &ldquo;Manage billing&rdquo;. One click, handled by Stripe, and you
                  keep the plan until the end of the month you paid for.
                </p>
              </details>
              <details>
                <summary>Can the person I share a read with see it without paying?</summary>
                <p>Yes. Shared links open for anyone, no account needed.</p>
              </details>
            </div>
          </div>
          <Photo src="/marketing/stock-paddle.jpg" alt="A pickleball paddle and balls on a court" ratio="4 / 5" />
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
