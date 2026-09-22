import fs from "node:fs";
import path from "node:path";

/**
 * A stock photograph slot that cannot render as a broken image.
 *
 * STOCK ONLY, by decision: every photo on the public site is a licensed
 * Unsplash or Pexels photo, downloaded by hand into public/marketing (nothing
 * in the build can fetch them). Until a file is there the slot shows a plain
 * branded panel -- deliberate-looking, never a broken-image icon on the page
 * a stranger opens first. Checked on the server at render, so dropping a file
 * in is a deploy with no code change.
 */
export function Photo({
  src,
  alt,
  ratio = "16 / 9",
  priority = false,
}: {
  src: string;
  alt: string;
  ratio?: string;
  priority?: boolean;
}) {
  if (!hasPublicFile(src)) {
    return <div className="mk-photo mk-photo-empty" style={{ aspectRatio: ratio }} aria-hidden="true" />;
  }
  return (
    <figure className="mk-photo" style={{ aspectRatio: ratio }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- swappable public file; next/image needs build-time dimensions */}
      <img src={src} alt={alt} loading={priority ? "eager" : "lazy"} />
    </figure>
  );
}

/** Whether a photo has been dropped in, for the slot and for the credits. */
export function hasPublicFile(p: string): boolean {
  return fs.existsSync(path.join(process.cwd(), "public", p.replace(/^\//, "")));
}
