"use client";

/**
 * Mark a court once; reuse it at that venue forever.
 *
 * The most accurate court fit this app has is a person dragging four corners.
 * What made that expensive was doing it on every upload — someone filming from
 * the same tripod spot every week was answering an identical question over and
 * over. This saves the answer.
 *
 * Applying a preset FILLS IN the corners, it does not lock them: the tripod
 * moves a few inches between sessions, and the corners stay draggable
 * afterwards exactly as if they had been placed by hand.
 */
import { useCallback, useEffect, useState } from "react";

import { scaleCorners, type CourtCorners, type CourtPreset } from "@/lib/db/court-presets";
import type { MatchMode } from "@/lib/db/setup";

type Corner = { x: number; y: number };

export interface CourtPresetBarProps {
  /** In [nearLeft, nearRight, farRight, farLeft] order, in video pixels. */
  corners: Corner[];
  lineColorHex: string | null;
  matchMode: MatchMode;
  /**
   * Read at click time rather than taken as a prop, because the video's
   * natural size lives on a ref and does not cause a re-render when it
   * arrives — a prop would be 0 on first paint and stay stale.
   */
  readFrameSize: () => { width: number; height: number } | null;
  onApply: (corners: Corner[]) => void;
}

export default function CourtPresetBar({
  corners, lineColorHex, matchMode, readFrameSize, onApply,
}: CourtPresetBarProps) {
  const [presets, setPresets] = useState<CourtPreset[]>([]);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [naming, setNaming] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/court-presets");
      if (!res.ok) return;
      const json = await res.json();
      setPresets(json.presets ?? []);
    } catch {
      // A picker that fails to load is a missing convenience, not a broken
      // setup screen — the user can still mark the court by hand.
    }
  }, []);

  // Fetch-on-mount. The set-state-in-effect rule is aimed at synchronous
  // setState during render, which loops; this is a network response arriving
  // later, which is the one legitimate shape the rule cannot distinguish. The
  // list has to be present before the user opens the picker -- loading it on
  // first interaction would show an empty dropdown and read as broken.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const apply = (preset: CourtPreset) => {
    const size = readFrameSize();
    if (!size) {
      setNote("The video hasn't loaded yet — give it a moment and try again.");
      return;
    }
    const scaled = scaleCorners(
      preset.corners,
      { width: preset.frameWidthPx, height: preset.frameHeightPx },
      size
    );
    if (!scaled) {
      setNote("That court was saved at a frame size this video can't be matched to.");
      return;
    }
    onApply([
      { x: scaled.nearLeft[0], y: scaled.nearLeft[1] },
      { x: scaled.nearRight[0], y: scaled.nearRight[1] },
      { x: scaled.farRight[0], y: scaled.farRight[1] },
      { x: scaled.farLeft[0], y: scaled.farLeft[1] },
    ]);
    const resized = preset.frameWidthPx !== size.width || preset.frameHeightPx !== size.height;
    setNote(
      `Loaded “${preset.name}”${resized ? ", scaled to this video's size" : ""}. `
      + "Drag any corner if the camera moved."
    );
  };

  const save = async () => {
    const size = readFrameSize();
    if (corners.length !== 4 || !size) {
      setNote("Mark all four corners first.");
      return;
    }
    setSaving(true);
    setNote(null);
    try {
      const body: {
        name: string; corners: CourtCorners;
        frameWidthPx: number; frameHeightPx: number;
        lineColorHex: string | null; matchMode: MatchMode;
      } = {
        name: name.trim(),
        corners: {
          nearLeft: [corners[0].x, corners[0].y],
          nearRight: [corners[1].x, corners[1].y],
          farRight: [corners[2].x, corners[2].y],
          farLeft: [corners[3].x, corners[3].y],
        },
        frameWidthPx: size.width,
        frameHeightPx: size.height,
        lineColorHex,
        matchMode,
      };
      const res = await fetch("/api/court-presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        setNote(json.error ?? "That court couldn't be saved.");
        return;
      }
      setNote(`Saved as “${json.preset.name}”. It'll be in this list next time.`);
      setNaming(false);
      setName("");
      await load();
    } catch {
      setNote("That court couldn't be saved — check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  const canSave = corners.length === 4;

  return (
    <div className="stack g2" style={{ marginTop: 8 }}>
      {presets.length > 0 && (
        <label className="sm" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ whiteSpace: "nowrap" }}>Saved courts</span>
          <select
            className="input"
            defaultValue=""
            onChange={(e) => {
              const p = presets.find((x) => x.id === e.target.value);
              if (p) apply(p);
              e.currentTarget.value = "";
            }}
          >
            <option value="" disabled>Pick a court you&apos;ve marked before…</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
      )}

      {naming ? (
        <div className="row g2">
          <input
            className="input"
            autoFocus
            placeholder="e.g. Balboa Park court 3"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) void save(); }}
          />
          <button type="button" className="btn btn-sm btn-primary"
            disabled={saving || !name.trim()} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" className="btn btn-sm btn-ghost"
            onClick={() => { setNaming(false); setName(""); }}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="row g2">
          <button
            type="button"
            className="btn btn-sm btn-soft"
            disabled={!canSave}
            onClick={() => setNaming(true)}
            title={canSave ? "Reuse these corners next time you film here"
                           : "Mark all four corners first"}
          >
            Save this court
          </button>
        </div>
      )}

      {note && <p className="sm muted" style={{ margin: 0 }}>{note}</p>}
    </div>
  );
}
