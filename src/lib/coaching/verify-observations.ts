/**
 * Watch the moment again, close up, and delete the points the footage does
 * not show.
 *
 * WHY THIS EXISTS, in the reporter's own words: "it wasn't a deep hit at all,
 * it was right at the kitchen"; "the ball was on the other side and the play
 * was already over"; "it wasn't a speed up, it was a dink"; "the player was
 * down and did hinge at the hips". Four coaching points, four things the
 * footage plainly contradicts.
 *
 * None of them is a reasoning failure. The scan watches a whole game in ONE
 * pass at ten frames a second and, to keep the bill sane, at LOW media
 * resolution -- about 66 tokens a frame against 258 at high. That is enough to
 * see where people are and roughly what happened; it is not enough to tell a
 * dink from a speed-up, a hinge from a slouch, or a ball at the kitchen from
 * one at the baseline. The model is then asked for a page of specific,
 * checkable coaching, so it writes specifics it could not see.
 *
 * So each point is re-watched on its own: four seconds of video at HIGH
 * resolution, with the same marked still that says who the subject is, and one
 * question -- does this footage show what this sentence claims? A point the
 * second look contradicts is deleted rather than softened, because a wrong
 * specific is what makes a reader stop believing the right ones.
 *
 * THE COST IS SMALL AND BOUNDED. A four-second window at 10fps is forty frames;
 * at high resolution that is about 10k tokens, against the tens of thousands
 * of frames in the scan itself. Ten points is a rounding error on the run, and
 * it is spent on the only part of the read anybody acts on.
 */

import { generateJSON, type UploadedFile } from "./gemini";
import { mapWithConcurrency } from "./concurrency";

/** Seconds either side of a cited moment. A stroke and its approach. */
export const VERIFY_LEAD_S = 2.5;
export const VERIFY_TRAIL_S = 2.0;
/** A rally-level claim is watched whole, up to this. Past it, around the start. */
export const VERIFY_MAX_S = 14;
const VERIFY_FPS = 10;
const VERIFY_CONCURRENCY = 3;

export type Verdict = "confirmed" | "wrong" | "unclear";

export interface VerifiableObservation {
  title: string;
  detail: string;
  valence: "strength" | "weakness";
  shot_t?: number | null;
  rally_idx?: number | null;
  /**
   * Set when the second look could not settle this one.
   *
   * KEPT AND LABELLED rather than deleted: the window genuinely did not show
   * enough -- the player was out of frame, the ball was not visible, it was
   * too far away. Deleting on that would quietly empty a read of everything
   * that happens at the far baseline, where this camera sees least. Saying it
   * lets the reader weigh the point instead of taking it on faith.
   */
  unconfirmed?: boolean;
}

export interface VerifyWindow {
  startSeconds: number;
  endSeconds: number;
  /** Whether the window came from a named moment or from a whole rally. */
  kind: "moment" | "rally";
}

/**
 * The seconds to re-watch for one point, or null when there is nothing to
 * watch -- no time, no rally. A claim with no moment cannot be checked, and
 * pretending otherwise by picking one is how the first version of the evidence
 * clips ended up showing a player about to serve.
 */
export function verifyWindow(
  o: VerifiableObservation,
  rallies: ReadonlyArray<{ idx: number; start_s: number; end_s: number }>,
  clipSeconds: number,
): VerifyWindow | null {
  // Number(null) is 0, not NaN -- so "no time given" reads as "a moment at the
  // very start of the clip" unless null is checked before the conversion.
  const t = o.shot_t === null || o.shot_t === undefined ? NaN : Number(o.shot_t);
  if (Number.isFinite(t)) {
    return {
      startSeconds: Math.max(0, t - VERIFY_LEAD_S),
      endSeconds: Math.min(clipSeconds || t + VERIFY_TRAIL_S, t + VERIFY_TRAIL_S),
      kind: "moment",
    };
  }
  const r = o.rally_idx === null || o.rally_idx === undefined
    ? null
    : rallies.find((x) => x.idx === o.rally_idx);
  if (!r || !(Number(r.end_s) > Number(r.start_s))) return null;
  const start = Math.max(0, Number(r.start_s) - 0.5);
  const end = Math.min(clipSeconds || Number(r.end_s), Number(r.end_s) + 0.5);
  return { startSeconds: start, endSeconds: Math.min(end, start + VERIFY_MAX_S), kind: "rally" };
}

function prompt(o: VerifiableObservation, w: VerifyWindow): string {
  return [
    "You are checking one sentence of coaching against the footage it claims to describe.",
    "",
    "The player being coached is the one ringed in magenta in the attached still, labelled YOU.",
    "The video is a short window from the same clip: "
      + `${w.startSeconds.toFixed(1)}s to ${w.endSeconds.toFixed(1)}s, `
      + `at ${VERIFY_FPS} frames per second and full detail.`,
    "",
    "THE CLAIM",
    `Title: ${o.title}`,
    `What it says happened: ${o.detail}`,
    "",
    "THE QUESTION",
    "Does this window show that, done by the ringed player?",
    "",
    'Answer "confirmed" only if you can SEE it: the right player, doing the thing described,',
    "in this window. Check each specific separately, because the claim is only as true as its",
    "weakest part:",
    "  - WHO struck the ball. A shot hit by somebody on the other side of the net is not theirs.",
    "  - WHERE on the court they were. \"Behind the baseline\" and \"at the kitchen\" are different claims.",
    "  - WHAT the shot was. A dink, a drive, a drop, a speed-up, a reset and a lob are different shots.",
    "  - WHAT their body did. Bent knees and a hinge at the hips are not an upright stance.",
    "  - WHETHER THE POINT WAS EVEN LIVE. If the rally had already ended, nothing here is coachable.",
    "",
    'Answer "wrong" if the footage shows something different in any of those -- and say what it',
    "actually shows. Being contradicted on one specific makes the whole point wrong: the player",
    "will watch this clip, and a sentence that does not match what they see costs more than a",
    "missing sentence.",
    "",
    'Answer "unclear" when the window genuinely does not settle it -- the player is out of frame,',
    "the ball is not visible, it is too far away to tell. That is a real answer and not a failure.",
    "",
    "`seen` is one sentence of what the window actually shows, in plain words. Write it first and",
    "let the verdict follow from it.",
  ].join("\n");
}

const SCHEMA = {
  type: "object",
  properties: {
    seen: { type: "string" },
    verdict: { type: "string", enum: ["confirmed", "wrong", "unclear"] },
    correction: { type: "string", nullable: true },
  },
  required: ["seen", "verdict"],
} as const;

/**
 * What survives the second look.
 *
 * WRONG IS DELETED, UNCLEAR IS KEPT. They are different answers: "the footage
 * shows something else" is evidence against the claim, while "I could not tell
 * from this window" is the absence of evidence either way -- and deleting on
 * absence would quietly empty the read of everything that happens at the far
 * baseline, where this camera can see least.
 */
export function applyVerdicts<T extends { unconfirmed?: boolean }>(
  results: Array<{ o: T; out: { seen: string; verdict: Verdict; correction?: string | null } }>,
): { kept: T[]; dropped: Array<{ observation: T; seen: string; correction: string | null }>; unclear: number } {
  const kept: T[] = [];
  const dropped: Array<{ observation: T; seen: string; correction: string | null }> = [];
  let unclear = 0;
  for (const r of results) {
    if (r.out.verdict === "wrong") {
      dropped.push({ observation: r.o, seen: r.out.seen, correction: r.out.correction ?? null });
      continue;
    }
    if (r.out.verdict === "unclear") {
      unclear += 1;
      kept.push({ ...r.o, unconfirmed: true });
      continue;
    }
    kept.push(r.o);
  }
  return { kept, dropped, unclear };
}

export interface VerifiedResult<T> {
  kept: T[];
  dropped: Array<{ observation: T; seen: string; correction: string | null }>;
  unclear: number;
  unchecked: number;
}

/**
 * Check every weakness against the footage. Never throws.
 *
 * STRENGTHS ARE NOT CHECKED. A wrong compliment costs a reader nothing like a
 * wrong criticism does, and the calls are better spent on the sentences that
 * tell somebody to change how they play.
 */
export async function verifyObservations<T extends VerifiableObservation>(opts: {
  model: string;
  file: UploadedFile;
  observations: T[];
  rallies: ReadonlyArray<{ idx: number; start_s: number; end_s: number }>;
  clipSeconds: number;
  referenceFrame?: { mimeType: string; dataBase64: string } | null;
  onLog?: (line: string) => void;
}): Promise<VerifiedResult<T>> {
  const log = opts.onLog ?? (() => {});
  const jobs: Array<{ o: T; w: VerifyWindow }> = [];
  const kept: T[] = [];
  let unchecked = 0;
  for (const o of opts.observations) {
    if (o.valence === "strength") { kept.push(o); continue; }
    const w = verifyWindow(o, opts.rallies, opts.clipSeconds);
    if (!w) { kept.push(o); unchecked += 1; continue; }
    jobs.push({ o, w });
  }
  if (jobs.length === 0) {
    log(`verify: nothing to check (${unchecked} point(s) name no moment)`);
    return { kept, dropped: [], unclear: 0, unchecked };
  }

  const dropped: VerifiedResult<T>["dropped"] = [];
  let unclear = 0;
  const results = await mapWithConcurrency(jobs, VERIFY_CONCURRENCY, async ({ o, w }, i) => {
    try {
      const out = await generateJSON<{ seen: string; verdict: Verdict; correction?: string | null }>({
        model: opts.model,
        file: opts.file,
        prompt: prompt(o, w),
        schema: SCHEMA as unknown as Record<string, unknown>,
        image: opts.referenceFrame ?? null,
        video: {
          fps: VERIFY_FPS,
          startOffsetSeconds: w.startSeconds,
          endOffsetSeconds: w.endSeconds,
          // HIGH, and this is the whole point of the pass. The scan runs at
          // low resolution to keep a twenty-minute game affordable; four
          // seconds at high is what makes a dink distinguishable from a
          // speed-up.
          mediaResolution: "high",
        },
        maxOutputTokens: 1200,
        label: `verify ${i + 1}/${jobs.length}`,
      });
      return { o, out };
    } catch (err) {
      // A failed check is not a failed claim. Keeping it is the same position
      // the read was in before this pass existed.
      log(`verify: check ${i + 1} failed, keeping the point — ${err instanceof Error ? err.message : String(err)}`);
      return { o, out: { seen: "", verdict: "unclear" as Verdict, correction: null } };
    }
  });

  const applied = applyVerdicts(results.filter(Boolean) as Array<{ o: T; out: { seen: string; verdict: Verdict; correction?: string | null } }>);
  kept.push(...applied.kept);
  dropped.push(...applied.dropped);
  unclear = applied.unclear;
  log(`verify: ${jobs.length} point(s) re-watched at high resolution — `
    + `${jobs.length - dropped.length - unclear} confirmed, ${unclear} unclear, ${dropped.length} dropped`
    + (unchecked ? `, ${unchecked} had no moment to check` : ""));
  for (const d of dropped) {
    log(`verify: dropped "${d.observation.title}" — the footage shows: ${d.seen}`);
  }
  return { kept, dropped, unclear, unchecked };
}
