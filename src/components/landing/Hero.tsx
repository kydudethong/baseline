import fs from "node:fs";
import path from "node:path";
import Link from "next/link";
import type { ReactNode } from "react";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/**
 * Every claim in this strip is something the pipeline actually produces. The
 * reference design's fourth card was "Play Smarter — better decisions, more
 * wins", which promises an outcome rather than describing a feature; this one
 * says what the product will not do instead, because that is the thing that
 * makes the other three trustworthy.
 */
const FEATURES: Array<{ title: string; body: string; icon: ReactNode }> = [
  {
    title: "Rally & shot detection",
    body: "Every rally and every paddle contact, found from the ball's own flight and confirmed against the sound.",
    icon: <Icon><rect x="2.5" y="6" width="14" height="12" rx="2.5" /><path d="m16.5 12 5-3v9l-5-3" /></Icon>,
  },
  {
    title: "Coaching that cites the clip",
    body: "What happened, why it matters, what to change — each tied to the rally you can go and watch.",
    icon: <Icon><path d="M12 3 4 7v6c0 4.4 3.4 7.4 8 8 4.6-.6 8-3.6 8-8V7z" /><path d="m9 12 2 2 4-4" /></Icon>,
  },
  {
    title: "Progress across games",
    body: "Skill ratings and the weaknesses that keep coming back, tracked clip over clip.",
    icon: <Icon><path d="M4 19V9M10 19V5M16 19v-7M21 19H3" /></Icon>,
  },
  {
    title: "It says what it can't see",
    body: "No paddle is tracked and coverage varies. Anything unmeasured reads “not available”, never a zero.",
    icon: <Icon><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" /></Icon>,
  },
];

/** Swap this file (same path) to change the hero photograph. */
const HERO_IMAGE = "/brand/hero.webp";

export function Hero({ analyzeHref, nav }: { analyzeHref: string; nav?: ReactNode }) {
  // Checked rather than assumed: swapping the file out should degrade to the
  // drawn panel, never to a broken image on the first screen anyone sees.
  const hasPhoto = fs.existsSync(path.join(process.cwd(), "public", "brand", "hero.webp"));

  return (
    <section className="lp">
      {hasPhoto ? (
        <div className="lp-photo" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element -- a swappable brand file, not a build-time asset; next/image wants fixed dimensions. */}
          <img src={HERO_IMAGE} alt="" />
        </div>
      ) : (
        <div className="lp-noart" aria-hidden="true" />
      )}
      <div className="lp-scrim" aria-hidden="true" />

      {nav ? <div className="lp-in">{nav}</div> : null}

      <div className="lp-in">
        <div className="lp-hero">
          <div className="lp-copy">
            <span className="eyebrow" style={{ color: "var(--optic)" }}>Now in early access</span>
            <h1 className="lp-h1">
              Get better at pickleball, <em>faster.</em>
            </h1>
            <p className="lp-sub">
              Upload one clip. Baseline finds every rally and every paddle contact, measures
              what your body did at each one, and tells you the single change worth making —
              and which drill fixes it.
            </p>
            <div className="lp-cta">
              <Link href={analyzeHref} className="btn btn-optic">Analyze your game →</Link>
              <a href="#how-it-works" className="btn btn-soft">See how it works</a>
            </div>
            <p className="lp-note">Free while in early access. No card required.</p>
          </div>

        </div>
      </div>

      <div className="lp-in">
        <div className="lp-feats">
          {FEATURES.map((f) => (
            <div key={f.title} className="lp-feat">
              <span className="ic">{f.icon}</span>
              <span className="t">{f.title}</span>
              <span className="d">{f.body}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
