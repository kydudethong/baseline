import test from "node:test";
import assert from "node:assert/strict";
import { ytdlpFailure } from "./ytdlp-error";

/** What execFile actually throws: the command echoed first, stderr after. */
const execErr = (stderr: string) => Object.assign(
  new Error(`Command failed: /opt/venv/bin/yt-dlp https://youtube.com/watch?v=x -f bv*[height<=1080]`
    + `[ext=mp4]+ba[ext=m4a]/b --merge-output-format mp4 --no-playlist --no-progress\n${stderr}`),
  { stderr, stdout: "" }
);

test("the command echo is discarded and stderr is what survives", () => {
  const { message } = ytdlpFailure(execErr("ERROR: [youtube] x: Video unavailable"));
  assert.match(message, /Video unavailable/);
  assert.doesNotMatch(message, /Command failed|--merge-output-format|opt\/venv/,
    "the command line is the half we already know");
});

test("the ERROR: line wins over surrounding noise", () => {
  const { message } = ytdlpFailure(execErr(
    "WARNING: [youtube] Falling back to generic extractor\n"
    + "ERROR: [youtube] abc: Sign in to confirm you're not a bot\n"
    + "  Use --cookies-from-browser to pass a session"
  ));
  assert.match(message, /not a bot/);
});

test("the bot check names the datacenter-IP cause, not the literal text", () => {
  const { hint } = ytdlpFailure(execErr("ERROR: Sign in to confirm you're not a bot"));
  assert.ok(hint);
  assert.match(hint, /blocking this server|IP/i);
  assert.match(hint, /upload|drop the file/i, "must give an action the user can take");
});

test("rate limit, forbidden and unavailable are told apart", () => {
  assert.match(ytdlpFailure(execErr("ERROR: HTTP Error 429: Too Many Requests")).hint!, /rate-limit/i);
  assert.match(ytdlpFailure(execErr("ERROR: HTTP Error 403: Forbidden")).hint!, /refused/i);
  assert.match(ytdlpFailure(execErr("ERROR: Private video. Sign in if you've been granted access")).hint!,
    /not publicly downloadable/i);
});

test("an unrecognised failure still surfaces the real line", () => {
  const { message, hint } = ytdlpFailure(execErr("ERROR: unable to download video data: <urlopen error>"));
  assert.equal(hint, null, "no invented explanation for a failure we do not recognise");
  assert.match(message, /unable to download video data/);
});

test("no stderr at all falls back rather than throwing", () => {
  const { message } = ytdlpFailure(new Error("spawn ENOENT"));
  assert.match(message, /ENOENT/);
});

test("a traceback with no ERROR: line uses its last line", () => {
  const { message } = ytdlpFailure(execErr(
    "Traceback (most recent call last):\n  File \"x.py\", line 1\nRuntimeError: something broke\n"
  ));
  assert.match(message, /RuntimeError: something broke/);
});
