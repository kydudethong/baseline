import fs from "node:fs";
import path from "node:path";

/**
 * A photograph slot that cannot render as a broken image.
 *
 * `src` is the preferred file -- usually a stock photo Ky downloads by hand,
 * because nothing in the build can fetch from Unsplash. Until that file is
 * in public/, the slot shows `fallback`, one of the stills from his own games,
 * which are always present. Checked on the server at render, so swapping a
 * file in is a deploy with no code change.
 */
export function Photo({
  src,
  fallback,
  alt,
  ratio = "16 / 9",
  priority = false,
  caption,
}: {
  src: string;
  fallback: string;
  alt: string;
  ratio?: string;
  priority?: boolean;
  caption?: string;
}) {
  const has = (p: string) => fs.existsSync(path.join(process.cwd(), "public", p.replace(/^\//, "")));
  const use = has(src) ? src : fallback;
  return (
    <figure className="mk-photo" style={{ aspectRatio: ratio }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- swappable public file; next/image needs build-time dimensions */}
      <img src={use} alt={alt} loading={priority ? "eager" : "lazy"} />
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

/** Whether a stock photo has been dropped in, for the photo credits. */
export function hasPublicFile(p: string): boolean {
  return fs.existsSync(path.join(process.cwd(), "public", p.replace(/^\//, "")));
}
