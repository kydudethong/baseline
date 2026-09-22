import Link from "next/link";
import type { Metadata } from "next";
import { SiteNav } from "@/components/marketing/SiteNav";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { Photo } from "@/components/marketing/Photo";
import { marketingAuth } from "@/components/marketing/auth";

export const metadata: Metadata = {
  title: "For coaches — Baseline",
  description: "Film your students' games and send each one a read with clips and drills. They don't need an account.",
};

/**
 * The coach page. Describes only what exists today -- film a student's game,
 * send them the read by link, assign the drills -- and says plainly that
 * multi-student accounts are not built yet. A coach who signs up expecting a
 * roster screen and finds none is a coach who does not come back.
 */
export default async function CoachesPage() {
  const { isAuthed, startHref } = await marketingAuth();
  return (
    <div className="mk">
      <SiteNav isAuthed={isAuthed} current="/coaches" />

      <section className="mk-hero">
        <div className="mk-wrap mk-hero-grid">
          <div className="stack g4">
            <span className="mk-kicker">For coaches</span>
            <h1 className="mk-h1">Every student leaves with their game broken down.</h1>
            <p className="mk-lead">
              Film a student&apos;s game, tap which player they are, and send them the read: the one
              thing to fix, the clip that shows it, and the drills for it. It backs up what you told
              them on court with what the footage shows.
            </p>
            <div className="mk-cta">
              <Link href={startHref} className="btn btn-optic">Try it on a lesson</Link>
              <Link href="/pricing" className="btn btn-soft">Pricing</Link>
            </div>
          </div>
          <Photo
            src="/marketing/stock-coach.jpg"
            fallback="/marketing/low-ball.jpg"
            alt="A player at the kitchen line during a game"
            ratio="4 / 3"
            priority
          />
        </div>
      </section>

      <section className="mk-section alt">
        <div className="mk-wrap">
          <h2 className="mk-h2">What it does for a lesson.</h2>
          <div className="mk-steps">
            <div className="mk-step">
              <span className="n">1</span>
              <h3>Evidence for what you said</h3>
              <p>&ldquo;Bend your knees on dinks&rdquo; lands differently with the clip and the measured knee angle beside it.</p>
            </div>
            <div className="mk-step">
              <span className="n">2</span>
              <h3>Homework that fits</h3>
              <p>Drills matched to what the game actually showed, in order, so practice between lessons works on the right thing.</p>
            </div>
            <div className="mk-step">
              <span className="n">3</span>
              <h3>Doubles teams, as a team</h3>
              <p>Tag both partners and the read covers how they play together — spacing, the middle ball, getting up to the kitchen as a pair.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-wrap mk-split flip">
          <div className="stack g4">
            <h2 className="mk-h2">Your students don&apos;t need an account.</h2>
            <p className="mk-lead" style={{ fontSize: 16 }}>
              Every read has a share link. Send it by text after the lesson — it opens on any phone
              with the video, the clips and the drills, and nothing to sign up for.
            </p>
            <p className="sm" style={{ margin: 0, color: "var(--ink-3)" }}>
              Coaching a lot of players? Accounts built for coaches, with a student list, are on the
              way. Until then, one account can analyse any game you film.
            </p>
          </div>
          <Photo
            src="/marketing/tracking.jpg"
            fallback="/marketing/tracking.jpg"
            alt="Every player's body and the ball measured through a rally"
            caption="What your student gets: their game, measured"
          />
        </div>
      </section>

      <section className="mk-section alt">
        <div className="mk-wrap">
          <div className="mk-band">
            <h2 className="mk-h2" style={{ color: "#fff" }}>Try it on your next lesson.</h2>
            <p>Film one game from behind the baseline. The first one each month is free.</p>
            <Link href={startHref} className="btn btn-optic">Analyze a game free</Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
