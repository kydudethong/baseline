/**
 * Does Gemini actually honour a frame-rate request, and can it see a swing?
 *
 * TWO QUESTIONS, AND THE FIRST ONE IS NOT OPTIONAL. An ignored `fps` field
 * does not produce an error -- it produces a perfectly reasonable answer built
 * from one frame per second, which reads exactly like a correct answer and is
 * not one. The only proof the setting applied is the token count: sampling ten
 * times as many frames costs roughly ten times as many prompt tokens. So this
 * runs the SAME one-second window twice, at 1fps and at the requested rate,
 * and prints both counts side by side. If they do not diverge, the field was
 * dropped and nothing else in the output means anything.
 *
 * Then the second question: with the stroke actually visible, does the model
 * describe it in terms you could coach from.
 *
 * Usage:
 *   npx tsx scripts/gemini-fps-probe.ts <video.mp4> <contactSeconds> [fps]
 *
 * Pick a contact time you can see in the footage -- the point of this is to
 * compare what it says against what you know is there.
 */
import fsp from "node:fs/promises";
import path from "node:path";

import { uploadVideo, deleteFile, generateJSON, type UsageInfo, type VideoConfig }
  from "../src/lib/coaching/gemini";

/** Same reader run-shots.ts uses — no dotenv dependency for one file. */
async function loadEnvLocal() {
  try {
    const text = await fsp.readFile(path.join(process.cwd(), ".env.local"), "utf8");
    for (const line of text.split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env.local — rely on the environment */
  }
}

const SCHEMA = {
  type: "object",
  properties: {
    striker_court: {
      type: "string",
      description: "near (closest to the camera) / far / unclear — which half the striker was in.",
    },
    frames_of_the_stroke_seen: {
      type: "integer",
      description: "How many DISTINCT frames of the swing you can actually distinguish.",
    },
    stroke_visible: {
      type: "boolean",
      description: "Could you see backswing, contact and follow-through, or only a still?",
    },
    paddle_face: { type: "string", description: "open / closed / neutral / cannot tell" },
    contact_height: { type: "string", description: "relative to their own body" },
    one_correction: { type: "string", description: "The single thing you would change." },
    confidence: { type: "string", description: "high / medium / low, and why." },
  },
  required: ["striker_court", "frames_of_the_stroke_seen", "stroke_visible", "paddle_face",
             "contact_height", "one_correction", "confidence"],
};

const PROMPT =
  "You are watching a one-second window of a pickleball point containing a single stroke. "
  + "Describe ONLY what you can actually see in the frames you were given. "
  + "If you were shown too few frames to see the swing happen, say so plainly in `confidence` "
  + "and set stroke_visible to false rather than inferring a plausible stroke. "
  + "Do not describe anything outside this window.";

async function probe(
  file: Awaited<ReturnType<typeof uploadVideo>>,
  model: string,
  video: VideoConfig,
  label: string
): Promise<{ usage: UsageInfo | null; out: Record<string, unknown> }> {
  let usage: UsageInfo | null = null;
  const out = await generateJSON<Record<string, unknown>>({
    model, file, prompt: PROMPT, schema: SCHEMA, video,
    onUsage: (u) => { usage = u; },
    onLog: (l) => console.error(`  [${label}] ${l}`),
  });
  return { usage, out };
}

async function main() {
  await loadEnvLocal();
  const [videoPath, tRaw, fpsRaw] = process.argv.slice(2);
  if (!videoPath || !tRaw) {
    console.error("usage: npx tsx scripts/gemini-fps-probe.ts <video.mp4> <seconds[,seconds,...]> [fps]");
    console.error("  e.g. npx tsx scripts/gemini-fps-probe.ts clip.mp4 8.0,13.2,29.0,44.1 15");
    process.exit(1);
  }
  const times = tRaw.split(",").map(Number).filter((n) => Number.isFinite(n));
  if (times.length === 0) {
    console.error("No usable timestamps. Pass seconds, comma-separated.");
    process.exit(1);
  }
  const fps = Number(fpsRaw ?? 15);
  // ASYMMETRIC AND WIDER THAN THE STROKE, for two reasons the 44.13s probe
  // showed: a swing is backswing -> contact -> follow-through, so the window
  // must LEAD the contact rather than straddle it; and the timestamp itself
  // can be off. At 44.13s Gemini reported "the stroke was executed before the
  // clip started" on a +/-0.5s window, which means that contact time was more
  // than half a second late. Leading by 1.2s absorbs that; trailing by 0.6s
  // catches the follow-through. Overridable because the right numbers depend
  // on where the timestamps come from, and Gemini's own will be better than
  // the ball detector's were.
  const lead = Number(process.env.PROBE_LEAD_S ?? 1.2);
  const trail = Number(process.env.PROBE_TRAIL_S ?? 0.6);
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash";

  // ONE upload for every timestamp. Re-uploading a 23MB clip per probe was
  // most of the wall-clock cost of finding a usable contact, and the file
  // reference is reusable across calls.
  const bytes = await fsp.readFile(videoPath);
  console.error(`uploading ${(bytes.length / 1e6).toFixed(1)}MB once for ${times.length} probe(s)…`);
  const file = await uploadVideo(bytes, path.basename(videoPath));

  try {
    // The 1fps control runs on the FIRST timestamp only. Frame-rate control is
    // already proven (166 -> 4060 tokens); this stays as a regression guard so
    // a silent API change cannot turn every later answer into a one-frame
    // guess without anyone noticing.
    const t0 = times[0];
    const control = await probe(file, model,
      { fps: 1, startOffsetSeconds: Math.max(0, t0 - lead), endOffsetSeconds: t0 + trail }, "control");

    const rows: string[] = [];
    for (const t of times) {
      const r = await probe(file, model,
        { fps, startOffsetSeconds: Math.max(0, t - lead), endOffsetSeconds: t + trail,
          mediaResolution: "high" },
        `${t}s`);
      const o = r.out as Record<string, string | number | boolean>;
      rows.push(
        `${String(t).padStart(7)}s  ${String(o.striker_court).padEnd(8)} `
        + `visible=${String(o.stroke_visible).padEnd(5)} `
        + `paddle=${String(o.paddle_face).slice(0, 18).padEnd(18)} `
        + `${r.usage?.promptTokens ?? "?"} tok`
      );
      console.log(`\n=== ${t}s ===`);
      console.log(JSON.stringify(r.out, null, 2));
    }

    const cp = control.usage?.promptTokens ?? 0;
    console.log("\n=== SUMMARY ===");
    console.log(`  1fps control at ${t0}s: ${cp} prompt tokens (frame-rate control still working if the rows below are much larger)`);
    for (const r of rows) console.log("  " + r);
    console.log(
      "\n  Look for a row with striker_court=near AND visible=true — that is the"
      + "\n  one that decides whether high-fps technique analysis is viable."
    );
  } finally {
    await deleteFile(file.name).catch(() => {});
  }
}

main().catch((err) => {
  console.error(`\nfailed: ${(err as Error).message}`);
  process.exit(1);
});
