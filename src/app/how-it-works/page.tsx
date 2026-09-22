import Link from "next/link";
import type { Metadata } from "next";
import { SiteNav } from "@/components/marketing/SiteNav";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { Photo } from "@/components/marketing/Photo";
import { marketingAuth } from "@/components/marketing/auth";
import { FilmingGuide } from "@/components/upload/FilmingGuide";

export const metadata: Metadata = {
  title: "How it works — Baseline",
  description: "Film from behind the baseline, tap yourself, and get a coaching read with clips and drills.",
};

/**
 * Three steps, each with a real picture of that step. The filming guide is the
 * same component the upload page uses, so the advice here and the advice at
 * the moment of uploading cannot drift apart.
 */
export default async function HowItWorksPage() {
  const { isAuthed, startHref } = await marketingAuth();
  return (
    <div className="mk">
      <SiteNav isAuthed={isAuthed} current="/how-it-works" />

      <section className="mk-hero" style={{ paddingBottom: "var(--a6)" }}>
        <div className="mk-wrap stack g3" style={{ maxWidth: 780 }}>
          <span className="mk-kicker">How it works</span>
          <h1 className="mk-h1">Three steps, one of them is playing.</h1>
          <p className="mk-lead">
            Film a game, tell Baseline which player is you, and read what it found. A full game takes
            a few minutes to read, and it emails you when it&apos;s done.
          </p>
        </div>
      </section>

      <section className="mk-section alt">
        <div className="mk-wrap mk-split">
          <div className="stack g4">
            <span className="mk-kicker">Step 1</span>
            <h2 className="mk-h2">Film from behind the baseline.</h2>
            <p className="mk-lead" style={{ fontSize: 16 }}>
              Any phone works. Where you put it matters more than what it is — most weak reads come
              from footage filmed from the side or zoomed in.
            </p>
            <FilmingGuide />
          </div>
          <Photo src="/marketing/stock-court.jpg" alt="An empty pickleball court and net in the sun" ratio="4 / 3" />
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-wrap mk-split flip">
          <div className="stack g4">
            <span className="mk-kicker">Step 2</span>
            <h2 className="mk-h2">Check the court, tap yourself.</h2>
            <p className="mk-lead" style={{ fontSize: 16 }}>
              Baseline finds the court lines and the players on its own. You check the lines sit on
              the paint, then tap the player who is you — and your partner too, if you want a read on
              how you play together. That&apos;s the only thing only you can tell it.
            </p>
          </div>
          <Photo src="/marketing/stock-aerial.jpg" alt="Pickleball courts seen from above" />
        </div>
      </section>

      <section className="mk-section alt">
        <div className="mk-wrap mk-split">
          <div className="stack g4">
            <span className="mk-kicker">Step 3</span>
            <h2 className="mk-h2">Get your read.</h2>
            <ul className="mk-list">
              <li><strong>The one thing to fix first</strong>, with the clip where it happened.</li>
              <li><strong>Technique from measurements</strong> — knee bend, shoulder turn, contact point and follow-through, compared across your own shots.</li>
              <li><strong>Every rally</strong>, and what you did in each one.</li>
              <li><strong>Drills</strong> for what it found, in the order to do them.</li>
              <li><strong>Your partnership</strong> — spacing, who takes the middle, whether you get to the kitchen together.</li>
              <li><strong>A link to share it</strong> with a partner or coach. They don&apos;t need an account.</li>
            </ul>
          </div>
          <Photo src="/marketing/stock-woman.jpg" alt="A player focused on the ball during a game" ratio="4 / 3" />
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-wrap stack g4" style={{ maxWidth: 780 }}>
          <h2 className="mk-h2">What it can&apos;t do, said up front.</h2>
          <p className="mk-lead" style={{ fontSize: 16 }}>
            Baseline watches from one phone, so it can&apos;t see your paddle face, spin or grip, and it
            won&apos;t pretend to. It has no sound, so it won&apos;t tell you to &ldquo;communicate
            more&rdquo;. When it can&apos;t measure something it says so, instead of guessing — a read
            you can trust is worth more than a longer one.
          </p>
          <div className="mk-cta">
            <Link href={startHref} className="btn btn-optic">Analyze a game free</Link>
            <Link href="/pricing" className="btn btn-soft">See pricing</Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
