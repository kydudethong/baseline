/**
 * The "your read is ready" email: what it says.
 *
 * Pure -- no network, no Resend -- so the wording and the escaping can be
 * tested. send.ts is the part that talks to a mail provider.
 *
 * WHY THIS EMAIL EXISTS. A full game takes several minutes to read, and
 * nobody watches a progress bar for several minutes -- they close the tab. An
 * analysis nobody comes back to is one nobody pays for a second time. This is
 * the thing that brings them back, so it leads with the one sentence most
 * likely to make them click: the headline of their own read.
 */

export interface ReadEmailInput {
  kind: "ready" | "failed";
  title: string;
  /** The read's own headline, e.g. "Bend more on dinks". Null on failure. */
  headline: string | null;
  url: string;
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

/**
 * Escaped because the title is the user's own file name and the headline is
 * model output. Neither is trusted HTML, and an email client renders whatever
 * it is handed.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Subject lines get truncated at ~60 characters in most inboxes. */
function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export function readEmail(input: ReadEmailInput): EmailContent {
  const title = clip(input.title || "your game", 60);
  if (input.kind === "failed") {
    const subject = `Your read of ${title} didn't finish`;
    const text = [
      `The tracking on ${title} finished, but the coaching read on top of it didn't.`,
      "",
      "Open it to see why and run it again — re-running doesn't use any of your minutes:",
      input.url,
    ].join("\n");
    const html = `<p>The tracking on <strong>${escapeHtml(title)}</strong> finished, but the coaching read on top of it didn't.</p>`
      + `<p><a href="${escapeHtml(input.url)}">Open it to see why and run it again</a> — re-running doesn't use any of your minutes.</p>`;
    return { subject, html, text };
  }
  // THE HEADLINE IN THE SUBJECT. "Your analysis is ready" is the sentence
  // every app sends and everyone ignores; "Bend more on dinks" is about them.
  const subject = input.headline
    ? clip(`Your read: ${input.headline}`, 70)
    : `Your read of ${title} is ready`;
  const text = [
    `Your coaching read of ${title} is ready.`,
    ...(input.headline ? ["", input.headline] : []),
    "",
    "See the clips, what to fix first, and the drills for it:",
    input.url,
  ].join("\n");
  const html = `<p>Your coaching read of <strong>${escapeHtml(title)}</strong> is ready.</p>`
    + (input.headline ? `<p style="font-size:18px"><strong>${escapeHtml(input.headline)}</strong></p>` : "")
    + `<p><a href="${escapeHtml(input.url)}">See the clips, what to fix first, and the drills for it</a></p>`;
  return { subject, html, text };
}
