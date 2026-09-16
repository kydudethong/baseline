"use client";

import { useEffect, useRef } from "react";

/**
 * A video that plays ONE WINDOW of a longer file, and nothing else.
 *
 * WHY THIS IS NOT JUST A #t= FRAGMENT. The media-fragment syntax is in the
 * spec and is ignored by enough browsers that relying on it is a coin toss --
 * and the way it fails is the worst possible one: the element loads the whole
 * file at 0:00 and plays it. That is exactly what happened here. A player who
 * asked why their third shot pops up was handed the entire twenty-minute game
 * and left to find the moment themselves, which is not evidence, it is
 * homework.
 *
 * So the window is enforced in script. Seek to the start once the metadata is
 * in, and stop at the end. Both halves matter: without the seek it starts at
 * the beginning, and without the stop it runs on into the next three rallies.
 *
 * A CUT CLIP NEEDS NONE OF THIS -- it is already only those seconds -- so the
 * component is given no window and does nothing but render a <video>.
 */
export function EvidenceVideo({
  src, startSeconds, endSeconds, className,
}: {
  src: string;
  /** Omitted for an already-cut clip, which is its own window. */
  startSeconds?: number | null;
  endSeconds?: number | null;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const start = startSeconds ?? null;
  const end = endSeconds ?? null;

  useEffect(() => {
    const el = ref.current;
    if (!el || start === null) return;

    // Metadata may already be in by the time this runs -- an effect is not
    // guaranteed to beat a cached file -- so seek immediately as well as on
    // the event, or a fast load silently starts at zero.
    const seekToStart = () => {
      // Guard the seek: assigning currentTime before the browser knows the
      // duration throws in some engines and is ignored in others.
      if (el.readyState > 0 && Math.abs(el.currentTime - start) > 0.25) {
        try { el.currentTime = start; } catch { /* seek not ready; the event will retry */ }
      }
    };
    seekToStart();

    const onTime = () => {
      if (end !== null && el.currentTime >= end) {
        el.pause();
        // Back to the start rather than left on the last frame, so pressing
        // play again replays the moment instead of doing nothing.
        try { el.currentTime = start; } catch { /* nothing useful to do */ }
      }
    };

    el.addEventListener("loadedmetadata", seekToStart);
    el.addEventListener("timeupdate", onTime);
    return () => {
      el.removeEventListener("loadedmetadata", seekToStart);
      el.removeEventListener("timeupdate", onTime);
    };
  }, [src, start, end]);

  return (
    <video
      ref={ref}
      src={src}
      controls
      muted
      playsInline
      preload="metadata"
      className={className}
    />
  );
}
