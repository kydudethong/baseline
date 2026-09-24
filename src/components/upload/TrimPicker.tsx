"use client";

import { useRef, useState } from "react";
import { clock, secs } from "@/lib/format/duration";

/**
 * Choose the stretch of the game worth reading, before a byte is uploaded.
 *
 * THE FIRST THING A NEW PLAYER MEETS IS A REFUSAL. The free allowance is ten
 * minutes; a game is sixteen to nineteen. Without this, their options are to
 * pay before they have seen anything, or to go and find a video editor, and
 * most people do neither. Cutting in the browser turns that dead end into a
 * choice, and it costs nothing: the encoder is already running there.
 *
 * IT IS ALSO THE RIGHT ADVICE EVEN WHEN THERE IS NO LIMIT. A read of twelve
 * minutes of real rallies is better than a read of twenty minutes with the
 * warm-up, the water break and the argument about the score in it -- the
 * coaching pass spends its attention on whatever it is given.
 *
 * TWO HANDLES, NOT A TIMELINE EDITOR. Start and end, a preview that follows
 * whichever handle moved, and the resulting length said in words. Anything
 * more is a video editor, which is not what somebody standing at a court with
 * a phone wants to be using.
 */
export function TrimPicker({
  src,
  suggestedSeconds,
  value,
  onChange,
  disabled = false,
}: {
  /** Object URL for the chosen file. */
  src: string;
  /** The allowance worth fitting inside, when there is one. */
  suggestedSeconds?: number | null;
  value: { startSeconds: number; endSeconds: number } | null;
  onChange: (v: { startSeconds: number; endSeconds: number } | null) => void;
  disabled?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [opened, setOpened] = useState<boolean | null>(null);
  // OPEN BY DEFAULT ONLY WHEN THE CLIP WILL NOT FIT. Derived rather than set
  // from an effect: the answer is a function of the duration and the
  // allowance, and a state write in an effect is a second render that can
  // fight whatever the user just clicked.
  const open = opened ?? Boolean(duration && suggestedSeconds && duration > suggestedSeconds + 1);

  const start = value?.startSeconds ?? 0;
  const end = value?.endSeconds ?? duration;
  const length = Math.max(0, end - start);

  const set = (next: { startSeconds: number; endSeconds: number }) => {
    const s = Math.max(0, Math.min(next.startSeconds, duration - 1));
    const e = Math.max(s + 1, Math.min(next.endSeconds, duration));
    onChange(s <= 0.05 && e >= duration - 0.05 ? null : { startSeconds: s, endSeconds: e });
  };
  const preview = (t: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = Math.max(0, Math.min(t, duration));
  };

  return (
    <div className="stack g2">
      <video
        ref={videoRef}
        src={src}
        preload="metadata"
        playsInline
        muted
        controls={open}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        style={{ width: "100%", borderRadius: "var(--r2)", background: "#000", display: open ? "block" : "none" }}
      />

      {!open ? (
        <button type="button" className="btn btn-sm btn-soft" disabled={disabled} onClick={() => setOpened(true)}>
          Trim before uploading
        </button>
      ) : (
        <div className="stack g2">
          <div className="row g2" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <strong style={{ fontSize: 14 }}>Which stretch should be read?</strong>
            <span className="sm num">
              {clock(start)} – {clock(end)} · <strong>{secs(length)}</strong>
            </span>
          </div>

          <label className="field">
            <span className="hint">Start</span>
            <input
              type="range" min={0} max={Math.max(1, duration)} step={1} value={start} disabled={disabled}
              onChange={(e) => { const v = Number(e.target.value); set({ startSeconds: v, endSeconds: Math.max(v + 1, end) }); preview(v); }}
            />
          </label>
          <label className="field">
            <span className="hint">End</span>
            <input
              type="range" min={0} max={Math.max(1, duration)} step={1} value={end} disabled={disabled}
              onChange={(e) => { const v = Number(e.target.value); set({ startSeconds: Math.min(start, v - 1), endSeconds: v }); preview(v); }}
            />
          </label>

          {suggestedSeconds ? (
            <div className="row g2" style={{ flexWrap: "wrap" }}>
              <button
                type="button" className="btn btn-sm btn-ghost" disabled={disabled}
                onClick={() => { set({ startSeconds: start, endSeconds: start + suggestedSeconds }); preview(start); }}
              >
                {secs(suggestedSeconds)} from here
              </button>
              <button
                type="button" className="btn btn-sm btn-ghost" disabled={disabled}
                onClick={() => { const s = Math.max(0, duration - suggestedSeconds); set({ startSeconds: s, endSeconds: duration }); preview(s); }}
              >
                Last {secs(suggestedSeconds)}
              </button>
              <button
                type="button" className="btn btn-sm btn-ghost" disabled={disabled}
                onClick={() => { onChange(null); setOpened(false); }}
              >
                Use the whole clip
              </button>
            </div>
          ) : null}

          {suggestedSeconds && length > suggestedSeconds + 1 ? (
            <p className="sm" style={{ margin: 0, color: "var(--warn)" }}>
              That is {secs(length)}, and you have {secs(suggestedSeconds)} left this month. Trim it
              further or the analysis will be refused.
            </p>
          ) : (
            <p className="sm" style={{ margin: 0, color: "var(--ink-3)" }}>
              Cut out the warm-up and the standing around. A read of the rallies you actually played is
              better than a read of the gaps between them.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
