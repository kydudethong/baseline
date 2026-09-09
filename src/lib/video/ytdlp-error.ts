// Relative, not the "@/" alias: tsc does not rewrite path aliases, and the
// test build runs the emitted JS under plain node, where "@/..." resolves to
// nothing. Anything reachable from a test imports its neighbours by path.
import { describeError } from "../analysis/describe-error";

/**
 * What actually went wrong, out of a failed yt-dlp run.
 *
 * `execFile` builds its Error.message as "Command failed: <the entire command
 * line>\n<stderr>". The command is the part we already know — we just wrote it
 * — and stderr is the part that says why. Passing that message through
 * describeError() and then slicing the FIRST 300 characters therefore keeps
 * the useless half and truncates the answer, which is how this failure
 * reported itself as "...--force-keyframes-at-cuts W": the W was the first
 * letter of yt-dlp's real message.
 *
 * yt-dlp writes its own diagnosis as an `ERROR:` line, so prefer that; fall
 * back to the last non-empty stderr line, which is where a traceback ends up.
 */
export function ytdlpFailure(err: unknown): { message: string; hint: string | null } {
  const e = err as { stderr?: unknown; stdout?: unknown };
  const stderr = typeof e?.stderr === "string" ? e.stderr : "";
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find((l) => /^ERROR:/i.test(l));
  const raw = errorLine || lines[lines.length - 1] || describeError(err);
  const message = raw.replace(/^ERROR:\s*/i, "");

  // The failures worth naming, because each has a different answer and none of
  // them is guessable from yt-dlp's own wording.
  let hint: string | null = null;
  if (/not a bot|sign in to confirm|cookies/i.test(message)) {
    // The big one on a server. YouTube treats datacenter IPs as suspicious and
    // demands a signed-in session; the same URL fetches fine from a laptop,
    // which is why this works locally and never in the container.
    hint = "YouTube is blocking this server's IP and asking it to sign in. "
      + "It works from a home connection, so download the clip on your machine "
      + "and drop the file in above.";
  } else if (/HTTP Error 429|Too Many Requests/i.test(message)) {
    hint = "YouTube is rate-limiting this server. Wait a while, or upload the file directly.";
  } else if (/HTTP Error 403|Forbidden/i.test(message)) {
    hint = "YouTube refused the download from this server. Upload the file directly instead.";
  } else if (/Private video|Video unavailable|members-only|age-restricted/i.test(message)) {
    hint = "That video is not publicly downloadable. Upload the file directly instead.";
  } else if (/Requested format is not available/i.test(message)) {
    hint = "No MP4 stream matched the quality filter for that video.";
  }
  return { message, hint };
}
