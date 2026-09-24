/**
 * The weekly digest: what you worked on, and whether it is moving.
 *
 * WHY A WEEKLY EMAIL AT ALL. A coaching read is read once. The thing that
 * makes the product worth paying for a second month is the TREND -- the skill
 * that was 3.1 and is now 3.6, the fault that keeps coming back -- and that
 * lives on a page nobody has a reason to open between games. This is the
 * reason, once a week, in the place people already look.
 *
 * WHAT IT REFUSES TO SEND. An account with nothing new, or with one game and
 * no trend to speak of, gets nothing: an email that says "you did not play
 * this week" is a reason to unsubscribe, not to come back. See digestEmail
 * returning null.
 *
 * Pure, like read-email.ts: the wording is testable and the network is
 * somebody else's problem.
 */

import { escapeHtml, type EmailContent } from "./read-email";
import { clock } from "../format/duration";

export interface DigestSkill {
  name: string;
  /** The rating now, 1-5. */
  now: number;
  /** The rating from the previous game, when there was one. */
  before: number | null;
}

export interface DigestInput {
  /** Games analysed in the window. */
  gamesThisWeek: number;
  /** Minutes of footage read in the window. */
  minutesThisWeek: number;
  /** What the most recent read said to work on first. */
  topFix: string | null;
  /** Ratings that moved, biggest move first. */
  moved: DigestSkill[];
  /** A drill from the latest read, to give the email something to DO. */
  drill: string | null;
  url: string;
}

const MOVE_EPSILON = 0.15;

export function digestEmail(input: DigestInput): EmailContent | null {
  // NOTHING HAPPENED IS NOT NEWS. An email about a week somebody did not play
  // is a reason to unsubscribe rather than to come back.
  if (input.gamesThisWeek === 0) return null;

  const moved = input.moved
    .filter((m) => m.before !== null && Math.abs(m.now - (m.before as number)) >= MOVE_EPSILON)
    .sort((a, b) => Math.abs(b.now - (b.before as number)) - Math.abs(a.now - (a.before as number)))
    .slice(0, 3);

  const games = `${input.gamesThisWeek} game${input.gamesThisWeek === 1 ? "" : "s"}`;
  const subject = moved.length > 0
    ? `${moved[0].name} is ${moved[0].now > (moved[0].before as number) ? "up" : "down"} this week`
    : input.topFix
      ? `This week: ${input.topFix}`
      : `Your week: ${games}`;

  const arrow = (m: DigestSkill) => (m.now > (m.before as number) ? "▲" : "▼");
  const movedLines = moved.map(
    (m) => `${arrow(m)} ${m.name}: ${(m.before as number).toFixed(1)} → ${m.now.toFixed(1)}`
  );

  const text = [
    `You analysed ${games} this week — ${clock(input.minutesThisWeek * 60)} of footage.`,
    ...(movedLines.length ? ["", "What moved:", ...movedLines] : []),
    ...(input.topFix ? ["", `Still first on the list: ${input.topFix}`] : []),
    ...(input.drill ? ["", `The drill for it: ${input.drill}`] : []),
    "",
    input.url,
  ].join("\n");

  const html = [
    `<p>You analysed <strong>${games}</strong> this week — ${escapeHtml(clock(input.minutesThisWeek * 60))} of footage.</p>`,
    movedLines.length
      ? `<p><strong>What moved</strong></p><ul>${moved
          .map((m) => `<li>${escapeHtml(`${arrow(m)} ${m.name}`)}: ${(m.before as number).toFixed(1)} → <strong>${m.now.toFixed(1)}</strong></li>`)
          .join("")}</ul>`
      : "",
    input.topFix ? `<p><strong>Still first on the list:</strong> ${escapeHtml(input.topFix)}</p>` : "",
    input.drill ? `<p><strong>The drill for it:</strong> ${escapeHtml(input.drill)}</p>` : "",
    `<p><a href="${escapeHtml(input.url)}">See the whole trend</a></p>`,
  ].join("");

  return { subject, html, text };
}
