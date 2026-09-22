import Link from "next/link";
import { hasPublicFile } from "./Photo";

/**
 * Credits appear only for photos actually on the site. Neither the Unsplash
 * nor the Pexels licence requires them; crediting photographers is still the
 * decent thing, and a credit for a photo that is not shown would be a small
 * lie. Keep this list in step with the slots the pages use.
 */
const CREDITS = [
  { file: "/marketing/stock-hero.jpg", who: "eedgar ivann", site: "Unsplash", url: "https://unsplash.com/photos/tn98VMfWXEs" },
  { file: "/marketing/stock-paddle.jpg", who: "Brendan Sapp", site: "Unsplash", url: "https://unsplash.com/photos/l5UX-BuRc3E" },
  { file: "/marketing/stock-coach.jpg", who: "Venti Views", site: "Unsplash", url: "https://unsplash.com/photos/q97_OyjWS1U" },
  { file: "/marketing/stock-play.jpg", who: "sanketgraphy", site: "Pexels", url: "https://www.pexels.com/photo/34618472/" },
  { file: "/marketing/stock-court.jpg", who: "Franki Frank", site: "Pexels", url: "https://www.pexels.com/photo/29820786/" },
  { file: "/marketing/stock-aerial.jpg", who: "Franki Frank", site: "Pexels", url: "https://www.pexels.com/photo/29821186/" },
  { file: "/marketing/stock-woman.jpg", who: "hson", site: "Pexels", url: "https://www.pexels.com/photo/32975182/" },
  { file: "/marketing/stock-gear.jpg", who: "kadiravsarr", site: "Pexels", url: "https://www.pexels.com/photo/36513707/" },
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
          {shown.length > 0 ? (
            <>
              Photos by{" "}
              {shown.map((c, i) => (
                <span key={c.file}>
                  <a href={c.url} rel="noopener noreferrer" target="_blank">{c.who}</a> ({c.site})
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
