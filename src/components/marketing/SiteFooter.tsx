import Link from "next/link";
import { hasPublicFile } from "./Photo";

/**
 * Photo credits appear only for stock photos that are actually on the site.
 * Unsplash's licence does not require them; crediting the photographers is
 * still the decent thing, and a credit for a photo that is not shown would be
 * a small lie.
 */
const CREDITS = [
  { file: "/marketing/stock-hero.jpg", who: "eedgar ivann", url: "https://unsplash.com/photos/tn98VMfWXEs" },
  { file: "/marketing/stock-paddle.jpg", who: "Brendan Sapp", url: "https://unsplash.com/photos/l5UX-BuRc3E" },
  { file: "/marketing/stock-ball.jpg", who: "Laura Tang", url: "https://unsplash.com/photos/9AwSPN41C8U" },
  { file: "/marketing/stock-coach.jpg", who: "Venti Views", url: "https://unsplash.com/photos/q97_OyjWS1U" },
];

export function SiteFooter() {
  const shown = CREDITS.filter((c) => hasPublicFile(c.file));
  return (
    <footer className="mk-footer">
      <div className="mk-wrap mk-footer-in">
        <div className="stack g2">
          <strong>Baseline</strong>
          <span className="sm" style={{ color: "var(--ink-3)" }}>AI coaching from your own pickleball games.</span>
        </div>
        <nav className="mk-footer-links" aria-label="Footer">
          <Link href="/how-it-works">How it works</Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/coaches">For coaches</Link>
          <Link href="/login">Log in</Link>
        </nav>
      </div>
      <div className="mk-wrap">
        <p className="xs" style={{ color: "var(--ink-3)", margin: "var(--a4) 0 0" }}>
          Game photos are real games filmed for Baseline, with faces blurred.
          {shown.length > 0 ? (
            <>
              {" "}Additional photos from Unsplash by{" "}
              {shown.map((c, i) => (
                <span key={c.file}>
                  <a href={c.url} rel="noopener noreferrer" target="_blank">{c.who}</a>
                  {i < shown.length - 1 ? ", " : "."}
                </span>
              ))}
            </>
          ) : null}
        </p>
      </div>
    </footer>
  );
}
