"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { colorForPlayer, playerDisplayName } from "@/lib/vision/player-colors";
import { useDialog } from "@/components/ui/Dialog";

export interface TagPickerFrame {
  url: string;
  timestampSeconds: number;
  /** Only the players actually visible in this specific frame, box in image-normalized [0,1] coords. */
  boxes: Array<{ playerLabel: string; box: { x: number; y: number; width: number; height: number } }>;
}

const COACHING_KINDS: Array<{ value: string; label: string }> = [
  { value: "match_doubles", label: "Doubles match" },
  { value: "match_singles", label: "Singles match" },
  { value: "drill", label: "Drill session" },
  { value: "practice", label: "Practice / open play" },
];

/**
 * "Which one is you" + trigger the coaching pipeline. A real player can
 * come back under several player_N labels across one clip — Rally IQ's
 * tracker has no re-identification (see facts.ts's mergeSelfFragments()) —
 * so this is a multi-select, not a single pick, and shows several frames
 * spread across the clip rather than just one, since the player you're
 * looking for may only be a given color in some of them.
 */
export function PlayerTagPicker({
  analysisId,
  players,
  frames,
  width,
  height,
  initialSelfLabels,
  initialSkillLevel,
  initialPaddleHand,
  initialCoachingKind,
  initialNotes,
  hasExistingRead,
  frameless = false,
}: {
  analysisId: string;
  players: string[];
  frames: TagPickerFrame[];
  width: number;
  height: number;
  initialSelfLabels: string[];
  initialSkillLevel: string | null;
  initialPaddleHand: string | null;
  initialCoachingKind: string;
  initialNotes: string | null;
  hasExistingRead: boolean;
  /** Inside a Dialog the dialog is the card — skip the section's own frame and heading. */
  frameless?: boolean;
}) {
  const router = useRouter();
  const dialog = useDialog();
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelfLabels));
  const [skillLevel, setSkillLevel] = useState(initialSkillLevel ?? "");
  const [paddleHand, setPaddleHand] = useState(initialPaddleHand ?? "");
  const [coachingKind, setCoachingKind] = useState(initialCoachingKind);
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  // The clock only runs while a read is in flight, and resets each time one
  // starts. Driven by an interval rather than by the fetch, because the point
  // is to prove to a waiting person that the page is still alive -- a number
  // that only updates when the request finishes would prove nothing.
  // The start time is recorded by the click that begins the run, not by this
  // effect: resetting state from inside an effect is the shape that produces a
  // second render pass for no reason, and the click already knows when it
  // happened. The effect only ticks.
  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => setElapsedSeconds(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const colorIndex = new Map(players.map((p, i) => [p, i]));

  function toggle(label: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  async function submit() {
    if (selected.size === 0) {
      setError("Pick at least one player above — that's who the coaching read will be about.");
      return;
    }
    setBusy(true);
    setError(null);
    setElapsedSeconds(0);
    setStartedAt(Date.now());
    try {
      const res = await fetch(`/api/analyses/${analysisId}/coach`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          selfPlayerLabel: [...selected],
          skillLevel: skillLevel.trim() || null,
          paddleHand: paddleHand || null,
          coachingKind,
          notes: notes.trim() || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not generate a coaching read.");
      router.refresh();
      dialog?.close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate a coaching read.");
    } finally {
      setBusy(false);
      // Stops the interval. Left running, it would keep counting behind a
      // finished read for as long as the page stayed open.
      setStartedAt(null);
    }
  }

  return (
    <section className={frameless ? "stack g5" : "card stack g5"} id="tag">
      <div className="stack g2">
        {!frameless ? (
          <>
            <span className="eyebrow">Step 2 of 2</span>
            <h2 className="h2">Which player is you?</h2>
          </>
        ) : null}
        <p className="sm measure">
          Tap every box that&apos;s you. The tracker can lose you behind another player and pick you back up
          under a new color, so you may be more than one — that&apos;s expected. The frames below are spread
          across the clip so you can check.
        </p>
      </div>

      {frames.length > 0 ? (
        <div className="grid2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "var(--a3)" }}>
          {frames.map((f, i) => (
            <ReferenceFrame key={i} frame={f} width={width} height={height} colorIndex={colorIndex} />
          ))}
        </div>
      ) : null}

      <div className="row g2">
        {players.map((label, i) => {
          const isOn = selected.has(label);
          const color = colorForPlayer(label, colorIndex.get(label) ?? i);
          return (
            <button
              key={label}
              type="button"
              onClick={() => toggle(label)}
              className="pchip"
              aria-pressed={isOn}
              style={isOn ? { borderColor: color, backgroundColor: `${color}22`, color } : undefined}
            >
              <span className="sw" style={{ backgroundColor: color }} />
              {playerDisplayName(label)}
              {isOn ? " ✓" : ""}
            </button>
          );
        })}
      </div>

      <div className="dashline" />

      <div className="form-grid">
        <label className="field">
          <span>
            Skill level <span className="hint">optional</span>
          </span>
          <input
            type="text"
            value={skillLevel}
            onChange={(e) => setSkillLevel(e.target.value)}
            placeholder="3.5, or “beginner”"
            className="input"
            disabled={busy}
          />
        </label>
        <label className="field">
          <span>
            Paddle hand <span className="hint">optional</span>
          </span>
          <select value={paddleHand} onChange={(e) => setPaddleHand(e.target.value)} className="select" disabled={busy}>
            <option value="">Not sure</option>
            <option value="right">Right</option>
            <option value="left">Left</option>
          </select>
        </label>
        <label className="field">
          <span>Session type</span>
          <select value={coachingKind} onChange={(e) => setCoachingKind(e.target.value)} className="select" disabled={busy}>
            {COACHING_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="field">
        <span>
          Anything you want the coach to look at? <span className="hint">optional</span>
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="e.g. I was working on my split step"
          className="textarea"
          disabled={busy}
        />
      </label>

      <div className="stack g3" style={{ alignItems: "flex-start" }}>
        <button type="button" onClick={submit} disabled={busy} className="btn btn-optic">
          {busy ? "Writing your read…" : hasExistingRead ? "Regenerate coaching read" : "Get my coaching read"}
        </button>
        {busy ? (
          <div className="stack g2" style={{ width: "100%", maxWidth: 420 }}>
            <div className="progress indet">
              <div className="bar" />
            </div>
            {/* An ELAPSED CLOCK and the real stages, not a guess at a total.
                "usually under a minute" was measured against a version of this
                that made one call; it now uploads the overlay, watches the
                whole clip, re-watches every shot close up, and writes a
                session plan. Several minutes is normal and a wrong estimate is
                worse than none -- a person who is told "under a minute" starts
                wondering whether it crashed at ninety seconds, which is the
                exact confusion this line was meant to prevent.

                So: no total, a clock they can watch move, and the current
                stage by name. A clock that is still ticking is the cheapest
                possible proof that nothing has hung. */}
            <span className="status-line">
              <span className="dot" />
              {stageFor(elapsedSeconds)} · {formatElapsed(elapsedSeconds)} elapsed
            </span>
            <span className="xs">
              A full read watches the clip once, then re-watches every shot close
              up. On a long clip that is a few minutes — you can leave this page
              and come back, it keeps running.
            </span>
          </div>
        ) : null}
        {error ? <div className="error">{error}</div> : null}
      </div>
    </section>
  );
}

function ReferenceFrame({
  frame,
  width,
  height,
  colorIndex,
}: {
  frame: TagPickerFrame;
  width: number;
  height: number;
  colorIndex: Map<string, number>;
}) {
  return (
    <div className="frame" style={{ aspectRatio: `${width} / ${height}` }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={frame.url} alt={`Frame at ${frame.timestampSeconds.toFixed(1)}s`} />
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        {frame.boxes.map(({ playerLabel, box }) => {
          const color = colorForPlayer(playerLabel, colorIndex.get(playerLabel) ?? 0);
          return (
            <g key={playerLabel}>
              <rect
                x={box.x * width}
                y={box.y * height}
                width={box.width * width}
                height={box.height * height}
                fill="none"
                stroke={color}
                strokeWidth={Math.max(3, width / 480)}
                rx={4}
              />
              <text
                x={box.x * width + 6}
                y={box.y * height - 10}
                fill={color}
                fontSize={Math.max(20, width / 60)}
                fontWeight={700}
                fontFamily="var(--ui)"
              >
                {playerDisplayName(playerLabel)}
              </text>
            </g>
          );
        })}
      </svg>
      <span className="ts">{frame.timestampSeconds.toFixed(1)}s</span>
    </div>
  );
}

/**
 * The stage a read is most likely in, from elapsed time alone.
 *
 * An honest approximation, and labelled as the sequence rather than a claim
 * about this particular run: the server does not stream progress back to this
 * component, so these boundaries come from the shape of the pipeline (upload,
 * then one pass over the whole clip, then one short pass per shot, then the
 * plan) rather than from a signal. Naming the stages is still worth more than
 * a spinner, because it tells a waiting person what is being done and that the
 * longest part is near the end rather than at the start.
 */
function stageFor(seconds: number): string {
  if (seconds < 25) return "Uploading the clip";
  if (seconds < 90) return "Watching the whole clip";
  if (seconds < 420) return "Re-watching each shot close up";
  return "Writing your read and practice plan";
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}
