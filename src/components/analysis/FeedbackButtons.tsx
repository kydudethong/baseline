"use client";

import { useState } from "react";
import type { FeedbackTargetKind, FeedbackVerdict } from "@/lib/db/types";

/**
 * "Is this right?" on one coaching claim.
 *
 * WHY THE REASONS ARE A FIXED LIST AND ALSO FREE TEXT. Free text alone cannot
 * be counted — a hundred people saying the same thing in a hundred ways is
 * unusable as a training signal. A fixed list alone cannot capture what nobody
 * anticipated, which is precisely the category worth hearing. So the list
 * carries the countable signal and the box catches everything else, and the
 * box is optional because most people will not type and their click still
 * counts.
 *
 * WHY "NOT SURE" IS AN OPTION. A two-way control forces a guess from somebody
 * who does not know, and a guess is noise wearing the costume of signal. The
 * third button is how somebody says "I read this and I genuinely cannot tell",
 * which is itself a useful thing to learn about a coaching point.
 *
 * OPTIMISTIC, and it stays optimistic on failure. If the save fails the button
 * still shows what they chose and a small note says it did not save — because
 * silently reverting their click looks like the app ignoring them, which is a
 * far worse outcome than one lost label.
 */
const REASONS: Record<"wrong" | "unsure", Array<{ key: string; label: string }>> = {
  wrong: [
    { key: "didnt_happen", label: "That didn't happen" },
    { key: "wrong_player", label: "That wasn't me" },
    { key: "wrong_time", label: "Wrong moment" },
    { key: "bad_advice", label: "Advice is wrong" },
    { key: "too_vague", label: "Too vague to use" },
  ],
  unsure: [
    { key: "cant_tell", label: "Can't tell from the video" },
    { key: "unclear", label: "Don't understand it" },
  ],
};

export function FeedbackButtons({
  analysisId,
  targetKind,
  targetId,
  initialVerdict = null,
  compact = false,
}: {
  analysisId: string;
  targetKind: FeedbackTargetKind;
  targetId: string;
  initialVerdict?: FeedbackVerdict | null;
  compact?: boolean;
}) {
  const [verdict, setVerdict] = useState<FeedbackVerdict | null>(initialVerdict);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [failed, setFailed] = useState(false);
  const [thanks, setThanks] = useState(false);

  async function send(next: FeedbackVerdict, withReason?: string | null, withNote?: string) {
    setVerdict(next);
    setFailed(false);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          analysisId, targetKind, targetId,
          verdict: next,
          reason: withReason ?? null,
          note: withNote?.trim() || null,
        }),
      });
      if (!res.ok) throw new Error("save failed");
      if (withReason !== undefined) setThanks(true);
    } catch {
      setFailed(true);
    }
  }

  const showReasons = verdict === "wrong" || verdict === "unsure";

  return (
    <div className={`fb${compact ? " fb-compact" : ""}`}>
      <div className="fb-row">
        <span className="fb-q">Is this right?</span>
        <button
          type="button"
          className={`fb-btn${verdict === "right" ? " on good" : ""}`}
          onClick={() => send("right")}
          aria-pressed={verdict === "right"}
        >
          Yes
        </button>
        <button
          type="button"
          className={`fb-btn${verdict === "wrong" ? " on bad" : ""}`}
          onClick={() => send("wrong")}
          aria-pressed={verdict === "wrong"}
        >
          No
        </button>
        <button
          type="button"
          className={`fb-btn${verdict === "unsure" ? " on" : ""}`}
          onClick={() => send("unsure")}
          aria-pressed={verdict === "unsure"}
        >
          Not sure
        </button>
        {failed ? <span className="fb-note">Couldn&apos;t save that</span> : null}
        {thanks && !failed ? <span className="fb-note good">Saved — thanks</span> : null}
      </div>

      {showReasons && !thanks ? (
        <div className="fb-reasons">
          {REASONS[verdict].map((r) => (
            <button
              key={r.key}
              type="button"
              className={`chip${reason === r.key ? " on" : ""}`}
              onClick={() => { setReason(r.key); void send(verdict, r.key, note); }}
            >
              {r.label}
            </button>
          ))}
          <input
            className="input fb-note-input"
            placeholder="What actually happened? (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => { if (note.trim()) void send(verdict, reason, note); }}
          />
        </div>
      ) : null}
    </div>
  );
}
