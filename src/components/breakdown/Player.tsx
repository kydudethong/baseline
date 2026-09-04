"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Ball, PlayIcon } from "@/components/motifs/Motifs";

export interface RallyMark {
  idx: number;
  start_s: number;
  end_s: number;
  shots: number;
  /** First tagged coaching observation whose rally_idx matches this rally, if any — Baseline has no won/lost outcome (no shot-type or scoring signal), so this is the closest analog to coach's "coach note". */
  note: string | null;
}

function mmss(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const SPEEDS = [1, 1.5, 2, 0.5];

/** Index of the last rally whose start has passed — the "currently playing" rally. -1 before the first rally starts. */
function activeRallyIndex(time: number, rallies: RallyMark[]): number {
  let idx = -1;
  for (let i = 0; i < rallies.length; i++) {
    if (rallies[i].start_s <= time + 0.25) idx = i;
  }
  return idx;
}

/**
 * Studying a match means moving between rallies, not scrubbing a bar — so
 * rally navigation sits beside play rather than in a menu, and the timeline
 * shows every rally as a segment with the dead time left empty. Ported from
 * the original coach app's Player.tsx; adapted for a signed Supabase Storage
 * URL instead of a local /api/video route, and for coaching_rallies' real
 * shape (no won/lost outcome — Rally IQ's CV pipeline has no scoring
 * signal, so rally segments are neutral rather than colored by result).
 */
export default function Player({
  videoUrl,
  posterUrl,
  rallies,
  durationS,
}: {
  videoUrl: string;
  posterUrl?: string | null;
  rallies: RallyMark[];
  durationS: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(durationS || 0);
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(0);

  const total = duration || durationS || 1;
  // Derived from playback time on every render rather than mirrored into
  // its own state via an effect — avoids a setState-in-effect cascade for
  // something that's cheap to just recompute.
  const current = Math.max(0, activeRallyIndex(time, rallies));
  const rally = rallies[current];

  const seek = useCallback((t: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(total, t));
  }, [total]);

  const goToRally = useCallback((i: number) => {
    const clamped = Math.max(0, Math.min(rallies.length - 1, i));
    const target = rallies[clamped];
    if (target) seek(target.start_s);
  }, [rallies, seek]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play(); else video.pause();
  }, []);

  // Anyone studying a match will not reach for the mouse each time.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      switch (e.key) {
        case " ": e.preventDefault(); togglePlay(); break;
        case "ArrowLeft": e.preventDefault(); seek(time - 5); break;
        case "ArrowRight": e.preventDefault(); seek(time + 5); break;
        case "ArrowUp": e.preventDefault(); goToRally(current - 1); break;
        case "ArrowDown": e.preventDefault(); goToRally(current + 1); break;
        default: break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [time, current, togglePlay, seek, goToRally]);

  // Deep links from an observation card: #t=94.2
  useEffect(() => {
    const apply = () => {
      const m = /[#&]t=([\d.]+)/.exec(window.location.hash);
      if (m) seek(Number(m[1]));
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [seek]);

  return (
    <div className="player">
      <video
        ref={videoRef}
        src={videoUrl}
        poster={posterUrl ?? undefined}
        preload="metadata"
        playsInline
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || durationS)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onClick={togglePlay}
      />

      <div className="controls">
        <div
          className="timeline"
          role="slider"
          tabIndex={0}
          aria-label="Match timeline"
          aria-valuemin={1}
          aria-valuemax={rallies.length || 1}
          aria-valuenow={current + 1}
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            seek(((e.clientX - box.left) / box.width) * total);
          }}
        >
          <div className="tl-base" />
          {rallies.map((r, i) => (
            <button
              key={r.idx}
              type="button"
              className={`tl-r${r.note ? " noted" : ""}${i === current ? " cur" : ""}`}
              style={{
                left: `${(r.start_s / total) * 100}%`,
                width: `${Math.max(0.7, ((r.end_s - r.start_s) / total) * 100)}%`,
              }}
              title={`Rally ${r.idx} — ${(r.end_s - r.start_s).toFixed(1)}s, ${r.shots} contacts${r.note ? ` — ${r.note}` : ""}`}
              aria-label={`Rally ${r.idx}`}
              onClick={(e) => { e.stopPropagation(); goToRally(i); }}
            />
          ))}
          <div className="tl-head" style={{ left: `${(time / total) * 100}%` }}>
            <span className="bh"><Ball size={16} /></span>
          </div>
        </div>

        <div className="row g2">
          <button className="ctl ctl-play" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
            {playing ? (
              <svg width="13" height="15" viewBox="0 0 12 13" fill="currentColor" aria-hidden="true">
                <rect x="1" y="1" width="3.6" height="11" rx="1" />
                <rect x="7.4" y="1" width="3.6" height="11" rx="1" />
              </svg>
            ) : <PlayIcon size={14} />}
          </button>
          <button className="ctl" onClick={() => seek(time - 5)}>−5s</button>
          <button className="ctl" onClick={() => seek(time + 5)}>+5s</button>
          <span className="tc">{mmss(time)} / {mmss(total)}</span>
          <button className="ctl" onClick={() => {
            const next = (speedIdx + 1) % SPEEDS.length;
            setSpeedIdx(next);
            if (videoRef.current) videoRef.current.playbackRate = SPEEDS[next];
          }}>{SPEEDS[speedIdx].toFixed(1)}×</button>

          {rallies.length > 0 && (
            <div className="rnav">
              <button className="ctl" onClick={() => goToRally(current - 1)} disabled={current === 0} aria-label="Previous rally">‹</button>
              <span className="lbl">Rally {rally?.idx ?? "—"}</span>
              <button className="ctl" onClick={() => goToRally(current + 1)} disabled={current >= rallies.length - 1} aria-label="Next rally">›</button>
            </div>
          )}
        </div>

        {rally && (
          <div className="rmeta">
            <div className="stack" style={{ gap: 2 }}>
              <span className="k">Length</span>
              <span className="v">{(rally.end_s - rally.start_s).toFixed(1)}s</span>
            </div>
            <div className="stack" style={{ gap: 2 }}>
              <span className="k">Contacts</span><span className="v">{rally.shots}</span>
            </div>
            {rally.note && (
              <div className="stack" style={{ gap: 2, flex: 1, minWidth: 240 }}>
                <span className="k">Coach note</span>
                <span className="v" style={{ fontFamily: "var(--ui)", fontSize: 14, color: "rgba(255,255,255,.8)", lineHeight: 1.5, fontVariantNumeric: "normal" }}>
                  {rally.note}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
