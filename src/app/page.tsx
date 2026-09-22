import Link from "next/link";
import type { Metadata } from "next";
import { SiteNav } from "@/components/marketing/SiteNav";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { Photo } from "@/components/marketing/Photo";
import { marketingAuth } from "@/components/marketing/auth";
import { MINUTES_PER_MONTH, PRO_MINUTES_PER_MONTH } from "@/lib/db/quota";
import { PLAN_PRICE } from "@/lib/billing/plans";

export const metadata: Metadata = {
  title: "Baseline — AI pickleball coaching from your own games",
  description: "Film a game on your phone. Baseline finds your rallies, measures your technique, and tells you the one thing to fix first — with the drill for it.",
};

/**
 * The first page anybody sees, usually from a link somebody sent them at the
 * courts. SHORT on purpose: what it is, one real picture of it working, and
 * one button. Everything else has its own page now, where it used to be one
 * long scroll that asked the reader to find the part they cared about.
 *
 * Every photo is real: stills from real games, faces blurred, or licensed
 * stock where a stock file has been dropped in. No generated imagery.
 */
export default async function HomePage() {
  const { isAuthed, startHref } = await marketingAuth();
  return (
    <div className="mk">
      <SiteNav isAuthed={isAuthed} current="/" />

      <section className="mk-hero">
        <div className="mk-wrap mk-hero-grid">
          <div className="stack g4">
            <span className="mk-kicker">AI coaching from your own games</span>
            <h1 className="mk-h1">Film your game. Find out the one thing to fix.</h1>
            <p className="mk-lead">
              Prop your phone on the fence and play. Baseline watches the game, measures how you
              move and swing, and tells you what to work on first — with the clip that shows it
              and the drill that fixes it.
            </p>
            <div className="mk-cta">
              <Link href={startHref} className="btn btn-optic">Analyze a game free</Link>
              <Link href="/how-it-works" className="btn btn-soft">How it works</Link>
            </div>
            <p className="sm" style={{ margin: 0, color: "var(--ink-3)" }}>
              Your first {MINUTES_PER_MONTH} minutes every month are free. No card needed.
            </p>
          </div>
          <Photo
            src="/marketing/stock-hero.jpg"
            fallback="/marketing/night-game.jpg"
            alt="A doubles game of pickleball under the lights"
            ratio="4 / 3"
            priority
          />
        </div>
      </section>

      <section className="mk-section alt">
        <div className="mk-wrap mk-split">
          <Photo
            src="/marketing/tracking.jpg"
            fallback="/marketing/tracking.jpg"
            alt="Baseline's view of a game: the court lines, the net, each player's skeleton and the ball's path"
            caption="What Baseline sees: the court, every player's body, the ball"
          />
          <div className="stack g4">
            <h2 className="mk-h2">It watches the game the way a coach would.</h2>
            <ul className="mk-list">
              <li>Finds every rally and who hit what, from the whole game — not a highlight.</li>
              <li>Measures your knees, your turn, your contact point and your follow-through on the shots it can see clearly.</li>
              <li>Picks the one change worth making first, and shows you the moment it happened.</li>
              <li>Gives you drills for exactly that, and reads how you and your partner play together.</li>
            </ul>
            <Link href="/how-it-works" style={{ color: "var(--optic-deep)", fontWeight: 600 }}>
              See every step →
            </Link>
          </div>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-wrap">
          <div className="mk-band">
            <h2 className="mk-h2" style={{ color: "#fff" }}>Try it on your next game.</h2>
            <p>
              One game a month is free. If you play every week, the monthly plan is {PLAN_PRICE} for
              {" "}{PRO_MINUTES_PER_MONTH} minutes — about six games.
            </p>
            <div className="mk-cta">
              <Link href={startHref} className="btn btn-optic">Analyze a game free</Link>
              <Link href="/pricing" className="btn btn-soft">See pricing</Link>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
