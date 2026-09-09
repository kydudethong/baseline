import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";
import { attachVideo, getAnalysisForUser } from "@/lib/db/analyses";
import { uploadFileFromDisk } from "@/lib/storage/r2";
import { probeVideo } from "@/lib/video/ffmpeg";
import { describeError } from "@/lib/analysis/describe-error";
import { ytdlpFailure } from "@/lib/video/ytdlp-error";
import { isLocalDev } from "@/lib/deployment";
import { MAX_VIDEO_SIZE_BYTES } from "@/lib/video/validation";

const execFileAsync = promisify(execFile);



export const runtime = "nodejs";
export const maxDuration = 900;

const Body = z.object({
  url: z.string().trim().url(),
  /** Grab one game out of a two-hour match rather than the whole thing. */
  startSeconds: z.number().min(0).max(24 * 3600).optional(),
  durationSeconds: z.number().min(5).max(3600).optional(),
});

/**
 * Fetch a video by URL and attach it, so a link goes through exactly the same
 * path as an upload.
 *
 * The reason this exists is the reference library: professional matches are
 * published, and a benchmark needs many of them. Downloading a two-hour match
 * to measure ninety seconds of it is the wrong shape, so a start time and a
 * duration are part of the request and only that section is fetched.
 *
 * What gets kept is worth being explicit about. The clip lands in the user's
 * own storage exactly as an uploaded file would, and the reference library
 * built on top of it stores measurements rather than frames -- see
 * 0008_reference_library.sql. Nothing here republishes anyone's footage.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const analysis = await getAnalysisForUser(supabase, user.id, id);
  if (!analysis) return NextResponse.json({ error: "Analysis not found" }, { status: 404 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  }
  const { url, startSeconds, durationSeconds } = parsed.data;

  let tempDir: string | null = null;
  try {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pb-fetch-"));
    const outTemplate = path.join(tempDir, "clip.%(ext)s");

    // Cap the format so a 4K source does not arrive as a 12GB file for a
    // pipeline that samples at 720p anyway.
    const args = [
      url,
      "-f", process.env.YTDLP_FORMAT || "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b",
      "--merge-output-format", "mp4",
      "--no-playlist",
      "--no-progress",
      "-o", outTemplate,
    ];
    if (startSeconds !== undefined && durationSeconds !== undefined) {
      const end = startSeconds + durationSeconds;
      // Re-encode the section rather than keyframe-cutting it: an inexact cut
      // shifts every timestamp the analysis produces against the source.
      args.push("--download-sections", `*${startSeconds}-${end}`, "--force-keyframes-at-cuts");
    }

    try {
      await execFileAsync(process.env.YTDLP_PATH || "yt-dlp", args, { maxBuffer: 16 * 1024 * 1024 });
    } catch (err) {
      const detail = describeError(err);
      if (/ENOENT|not found/i.test(detail)) {
        // Who is reading this decides what it should say. On the laptop the
        // reader is the person who can fix it, and an install command is the
        // most useful sentence available. On the server the reader is a user
        // with no shell, and telling them to run `brew install` is worse than
        // saying nothing: it reads as broken software AND gives them an
        // instruction they cannot follow. Same fault, two audiences.
        const selfHosted = isLocalDev();
        return NextResponse.json({
          error: selfHosted
            ? "yt-dlp is not installed. Install it with `brew install yt-dlp` "
              + "(or `python3 -m pip install yt-dlp`) and try again."
            : "Pasting a link is unavailable on this server right now. "
              + "Download the clip yourself and drop the file in above — that path works.",
        }, { status: 503 });
      }
      // Log the whole thing; show the user the diagnosis. `fly logs` is where
      // the full command and stderr belong, not a red box on a form.
      console.error(`[from-url] yt-dlp failed: ${detail}`);
      const { message, hint } = ytdlpFailure(err);
      return NextResponse.json({
        error: hint ? `${hint} (${message.slice(0, 160)})` : `Could not fetch that video: ${message.slice(0, 300)}`,
      }, { status: 502 });
    }

    const files = (await fsp.readdir(tempDir)).filter((f) => f.startsWith("clip."));
    if (files.length === 0) {
      return NextResponse.json({ error: "The download produced no file." }, { status: 502 });
    }
    const localPath = path.join(tempDir, files[0]);
    const stat = await fsp.stat(localPath);
    if (stat.size > MAX_VIDEO_SIZE_BYTES) {
      return NextResponse.json({
        error: `That clip is ${(stat.size / 1e9).toFixed(1)} GB, over the limit. `
          + "Give a start time and duration to take just the part you want.",
      }, { status: 413 });
    }

    // Probe before storing: a file that will not analyse should fail here,
    // not three minutes into a run.
    const meta = await probeVideo(localPath);

    const storagePath = `${user.id}/${id}/source-${Date.now()}.mp4`;
    await uploadFileFromDisk(storagePath, localPath, "video/mp4");
    await attachVideo(supabase, {
      analysisId: id,
      userId: user.id,
      storagePath,
      originalFilename: path.basename(localPath),
      mimeType: "video/mp4",
      sizeBytes: stat.size,
    });

    return NextResponse.json({
      ok: true,
      sizeBytes: stat.size,
      durationSeconds: meta.durationSeconds,
      width: meta.width,
      height: meta.height,
    });
  } catch (err) {
    return NextResponse.json({ error: describeError(err) }, { status: 500 });
  } finally {
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
