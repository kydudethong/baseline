"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { colorForPlayer } from "@/lib/vision/player-colors";

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
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelfLabels));
  const [skillLevel, setSkillLevel] = useState(initialSkillLevel ?? "");
  const [paddleHand, setPaddleHand] = useState(initialPaddleHand ?? "");
  const [coachingKind, setCoachingKind] = useState(initialCoachingKind);
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setError("Pick at least one colored player below — that's who the coaching read will be about.");
      return;
    }
    setBusy(true);
    setError(null);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate a coaching read.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        {hasExistingRead ? "Re-tag & regenerate" : "Which player is you?"}
      </h3>
      <p className="mt-1 text-sm text-slate-600">
        Pick every colored box below that&apos;s you — if the tracker lost and re-found you during the
        clip, that can show up as more than one color, so select all of them. Shown across a few
        different moments in the clip since you won&apos;t be the same color in every frame.
      </p>

      {frames.length > 0 ? (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {frames.map((f, i) => (
            <ReferenceFrame key={i} frame={f} width={width} height={height} colorIndex={colorIndex} />
          ))}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {players.map((label, i) => {
          const isOn = selected.has(label);
          const color = colorForPlayer(label, colorIndex.get(label) ?? i);
          return (
            <button
              key={label}
              type="button"
              onClick={() => toggle(label)}
              className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition"
              style={
                isOn
                  ? { borderColor: color, backgroundColor: `${color}1a`, color }
                  : { borderColor: "var(--line-strong)", color: "var(--ink-2)" }
              }
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
              {label}
              {isOn ? " ✓" : ""}
            </button>
          );
        })}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="text-xs font-medium text-slate-500">Skill level (optional)</span>
          <input
            type="text"
            value={skillLevel}
            onChange={(e) => setSkillLevel(e.target.value)}
            placeholder="e.g. 3.5, or “beginner”"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-xs font-medium text-slate-500">Paddle hand (optional)</span>
          <select
            value={paddleHand}
            onChange={(e) => setPaddleHand(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          >
            <option value="">Not stated</option>
            <option value="right">Right</option>
            <option value="left">Left</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-xs font-medium text-slate-500">Session type</span>
          <select
            value={coachingKind}
            onChange={(e) => setCoachingKind(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          >
            {COACHING_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="mt-4 block text-sm">
        <span className="text-xs font-medium text-slate-500">Anything you want the coach to focus on? (optional)</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="e.g. I was working on my split step"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
        />
      </label>

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
        >
          {busy ? "Analyzing…" : hasExistingRead ? "Regenerate coaching read" : "Get my coaching read"}
        </button>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
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
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-black">
      <div className="relative" style={{ aspectRatio: `${width} / ${height}` }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={frame.url}
          alt={`Frame at ${frame.timestampSeconds.toFixed(1)}s`}
          className="absolute inset-0 h-full w-full object-contain"
        />
        <svg viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid meet">
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
                  strokeWidth={3}
                />
                <text x={box.x * width} y={box.y * height - 6} fill={color} fontSize={20} fontWeight={600}>
                  {playerLabel}
                </text>
              </g>
            );
          })}
        </svg>
        <div className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white">
          {frame.timestampSeconds.toFixed(1)}s
        </div>
      </div>
    </div>
  );
}
