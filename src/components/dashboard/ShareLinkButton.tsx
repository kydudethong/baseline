"use client";

import { useState } from "react";

/**
 * Hand somebody the link, in one tap, at a court.
 *
 * THE SHARE SHEET FIRST, because the whole use case is a phone in somebody
 * else's hand. navigator.share opens the real OS sheet -- Messages, WhatsApp,
 * AirDrop -- which is how a link actually gets from one person to another
 * standing next to them. Copying to the clipboard is the desktop fallback, and
 * showing the raw URL is the fallback to that, because a share button that
 * silently does nothing in an odd browser is worse than a URL somebody can
 * select by hand.
 */
export function ShareLinkButton({ url }: { url: string }) {
  const [state, setState] = useState<"idle" | "copied" | "shown">("idle");

  async function onClick() {
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: "A Baseline coaching read", url });
        return;
      } catch {
        // A cancelled share sheet throws the same way a broken one does, so
        // fall through to copying rather than reporting a failure that was
        // probably the person changing their mind.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
      setTimeout(() => setState("idle"), 2500);
    } catch {
      setState("shown");
    }
  }

  return (
    <div className="stack g2">
      <div className="row g2" style={{ alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="btn btn-soft btn-sm" onClick={onClick}
                title="Anyone with the link can watch this game — no account needed">
          {state === "copied" ? "Link copied ✓" : "Share this read"}
        </button>
      </div>
      {state === "shown" ? (
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="input"
          style={{ fontFamily: "var(--mono, monospace)", fontSize: 12 }}
        />
      ) : null}
    </div>
  );
}
