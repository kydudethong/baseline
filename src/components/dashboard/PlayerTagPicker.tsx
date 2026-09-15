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
  const [showAll, setShowAll] = useState(false);
  /**
   * How many chips to show before "show more".
   *
   * Six, not four: a doubles game is four people, and the tracker splitting one
   * of them in half is the normal case rather than the exception, so the list
   * has to have room for a couple of those without hiding a real player behind
   * a button.
   */
  const VISIBLE = 6;
  // Anything already tagged stays visible whatever its rank -- a selection the
  // user cannot see is a selection they cannot undo.
  const shown = showAll
    ? players
    : players.filter((p, i) => i < VISIBLE || selected.has(p));
  const hidden = players.filter((p) => !shown.includes(p));
  const [skillLevel, setSkillLevel] = useState(initialSkillLevel ?? "");
  const [paddleHand, setPaddleHand] = useState(initialPaddleHand ?? "");
  const [coachingKind, setCoachingKind] = useState(initialCoachingKind);
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // The server's own words for what it is doing, rather than this component's
  // guess from elapsed time.
  const [stage, setStage] = useState<string | null>(null);

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
    setStage(null);
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

      // The request only STARTS the run now — it answers in milliseconds and
      // the pipeline carries on server-side. So the wait happens here, by
      // polling, and the crucial property is that closing this tab no longer
      // kills anything: the run finishes either way and the read is there when
      // the page is next opened.
      await waitForRead(analysisId, (line) => setStage(line));
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
        {shown.map((label, i) => {
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
        {/* THE REST, BEHIND ONE CLICK.
            A doubles game is four people, and the tracker -- which has no
            re-identification -- hands back sixteen tracks for a fourteen-minute
            clip, because every time it loses somebody behind another player it
            picks them back up under a new id. Showing all sixteen at once asks
            a question ("which of these is you?") that looks much harder than it
            is. The long-lived ones come first, so the four that matter are the
            four on screen; the fragments are still reachable, because
            occasionally one of them IS you for part of the clip. */}
        {hidden.length > 0 ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll
              ? "Show fewer"
              : `+ ${hidden.length} more the tracker split off`}
          </button>
        ) : null}
      </div>
      {hidden.length > 0 && !showAll ? (
        <p className="xs" style={{ margin: 0, color: "var(--ink-3)" }}>
          Showing the {shown.length} players on court longest. The rest are
          short fragments — worth opening only if none of these is you.
        </p>
      ) : null}

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
              {stage ?? stageFor(elapsedSeconds)} · {formatElapsed(elapsedSeconds)} elapsed
            </span>
            <span className="xs">
              This runs on the server, not in this tab. You can close the page, and
              the read will be waiting for you when you come back.
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

/** How often the page asks whether the background run has finished. */
const POLL_MS = 3000;
/**
 * When to stop asking.
 *
 * Not a claim that the run has failed -- the run is server-side and carries on
 * regardless. It is a claim about this TAB: after twenty minutes, sitting here
 * is not how the person should find out, and the honest thing is to say so and
 * let them come back. That is only a reasonable thing to say because the work
 * genuinely survives the tab now.
 */
const POLL_GIVE_UP_MS = 20 * 60_000;

/**
 * Wait for a background coaching run, reporting the server's own stage text.
 *
 * Throws on a run the server recorded as failed -- which is the whole reason
 * analyses.progress carries an `error`. Without it, a run that died thirty
 * seconds in is indistinguishable from one still working, and the page would
 * poll for twenty minutes over nothing.
 */
async function waitForRead(analysisId: string, onStage: (line: string) => void): Promise<void> {
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let json: {
      hasCoachingRead?: boolean;
      progress?: { message?: string; error?: string; coachingDone?: boolean } | null;
    };
    try {
      const res = await fetch(`/api/analyses/${analysisId}/view?progress=1`, { cache: "no-store" });
      if (!res.ok) continue; // a blip in polling is not a failed run
      json = await res.json();
    } catch {
      continue;
    }

    if (json.progress?.error) throw new Error(json.progress.error);
    if (json.hasCoachingRead || json.progress?.coachingDone) return;
    if (json.progress?.message) onStage(json.progress.message);

    if (Date.now() - started > POLL_GIVE_UP_MS) {
      throw new Error(
        "This is taking longer than expected. The read is still running on the server — "
        + "close this and check back in a few minutes; it will be here."
      );
    }
  }
}
