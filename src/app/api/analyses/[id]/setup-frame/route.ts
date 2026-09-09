import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { getAnalysisForUser } from "@/lib/db/analyses";
import { downloadToFile } from "@/lib/storage/r2";
import { setupFrameViaRallySeg, rallySegInstalled } from "@/lib/vision/court-rally-seg";
import { describeError } from "@/lib/analysis/describe-error";
import { normaliseLineColor } from "@/lib/db/setup";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Find the frame to run setup on, and say who is standing in it.
 *
 * The alternative -- scrubbing the video by hand until all four players happen
 * to be visible and none of them is stood in front of another -- is a chore,
 * and a detector can do it exhaustively over the whole clip in less time than
 * it takes to explain. It also fits the court on the same pass, so the user
 * usually only has to confirm rather than click.
 *
 * Cached on disk, keyed by analysis id: this costs a video download and a
 * minute of Python, and re-running it on every page load would be rude.
 * `?refresh=1` forces a new pass.
 */

function cacheDir(): string {
  return process.env.SETUP_FRAME_DIR || path.join(process.cwd(), "public", "setup-frames");
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const analysis = await getAnalysisForUser(supabase, user.id, id);
  if (!analysis) return NextResponse.json({ error: "Analysis not found" }, { status: 404 });
  if (!analysis.video) return NextResponse.json({ error: "No video uploaded yet." }, { status: 400 });

  if (!rallySegInstalled()) {
    return NextResponse.json(
      { error: "Automatic setup needs the rally_seg pipeline, which is not installed here. Mark the court and players by hand instead." },
      { status: 503 }
    );
  }

  // The line colour the user sampled, if they have got that far. A court
  // that will not fit against white paint gets a second chance against the
  // colour that is actually on the ground, which is the whole point of
  // asking -- so this has to reach the fitter, not just the saved setup.
  let lineColorHex: string | null = null;
  try {
    const body = (await request.json()) as { lineColorHex?: unknown };
    lineColorHex = normaliseLineColor(body?.lineColorHex);
  } catch {
    // No body, or not JSON. The frame finder has always worked without one.
  }

  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  const dir = cacheDir();
  const jpegPath = path.join(dir, `${id}.jpg`);
  const metaPath = path.join(dir, `${id}.json`);

  // Only serve a cached payload that was measured against the video's real
  // dimensions. On a fresh upload `videos.width/height` are still null --
  // they are written during processing -- so an early setup visit measures in
  // rally_seg's own downscaled frame. Caching that forever meant the user
  // could never recover from it, even after processing filled the columns in.
  const knownSize = (analysis.video.width ?? 0) > 0 && (analysis.video.height ?? 0) > 0;
  if (!refresh && knownSize && fs.existsSync(jpegPath) && fs.existsSync(metaPath)) {
    try {
      const cached = JSON.parse(await fsp.readFile(metaPath, "utf8")) as {
        imageSize?: [number, number]; lineColorHex?: string | null;
      };
      // The colour is part of the cache key, not a detail. A payload fitted
      // against white paint is the wrong answer to "fit it against blue",
      // and serving it would make picking a colour look like it did nothing.
      const sameColour = (cached.lineColorHex ?? null) === lineColorHex;
      if (sameColour
          && cached.imageSize?.[0] === analysis.video.width
          && cached.imageSize?.[1] === analysis.video.height) {
        return NextResponse.json({ ...cached, cached: true });
      }
    } catch {
      // A corrupt cache is not worth an error page; fall through and redo it.
    }
  }

  let tempDir: string | null = null;
  try {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pb-setup-"));
    const localPath = path.join(tempDir, analysis.video.original_filename.replace(/[^\w.-]/g, "_"));
    await downloadToFile(analysis.video.storage_path, localPath);

    const width = analysis.video.width ?? 0;
    const height = analysis.video.height ?? 0;
    // Capture the diagnostics instead of discarding them: every failure detail
    // -- Python stderr, exit code, a timeout, "no frames could be read" --
    // goes through onLog, and without a callback a genuine failure was
    // indistinguishable from any other.
    const logs: string[] = [];
    const result = await setupFrameViaRallySeg(localPath, [width, height], jpegPath, (line) => {
      logs.push(line);
      console.warn(`[setup-frame ${id}] ${line}`);
    }, lineColorHex ? [["court.line_color_hex", lineColorHex]] : []);
    if (!result) {
      const why = logs.length ? logs[logs.length - 1] : "no diagnostic was produced";
      return NextResponse.json(
        { error: `The frame finder could not run on this video (${why}). Mark the court and players by hand instead.` },
        { status: 502 }
      );
    }

    // The JPEG is written at the resolution rally_seg worked at, which may be
    // smaller than the source. Report that size, not the video's, so every
    // coordinate the browser sends back is in the space of the image it was
    // actually looking at.
    const payload = {
      frameUrl: fs.existsSync(jpegPath) ? `/setup-frames/${id}.jpg?v=${Date.now()}` : null,
      frame: result.frame,
      players: result.players,
      court: result.calibration
        ? {
            corners: result.calibration.cornersImagePx,
            quadKind: result.calibration.quadKind,
            confidence: result.calibration.confidence,
            diagnostics: result.calibration.diagnostics,
          }
        : null,
      courtReason: result.courtReason,
      imageSize: result.imageSize,
      // Recorded so the cache check above can tell which colour this was
      // fitted against, rather than assuming every payload is comparable.
      lineColorHex,
    };
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(metaPath, JSON.stringify(payload), "utf8");
    return NextResponse.json({ ...payload, cached: false });
  } catch (err) {
    return NextResponse.json({ error: describeError(err) }, { status: 500 });
  } finally {
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
