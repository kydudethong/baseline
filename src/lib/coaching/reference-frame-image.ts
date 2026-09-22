/**
 * Build the one still that tells the coaching model who it is coaching.
 *
 * The overlay video carries no identity at all -- no boxes, no names, no
 * highlight on anybody -- so this image is the whole of the answer to "which of
 * these four people is this read for". If it cannot be built, the prompt is
 * told so and the model is instructed not to pick somebody; a read addressed to
 * a guessed subject is worse than one addressed to nobody, because it is
 * indistinguishable from a correct one.
 *
 * WHY IT IS BUILT HERE AND NOT AT TAG TIME. The player taps their box and we
 * store a LABEL, not a picture. Building the image at coaching time means a
 * re-run picks up a corrected tag, a re-rendered overlay or a fixed roster
 * without anybody having to re-tag; storing it at tag time would freeze the
 * first answer and quietly serve it to every later run.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Database } from "@/lib/db/types";
import { markPlayersOnFrameViaPython, type FrameMark } from "@/lib/vision/cv-scripts";
import { pickReferenceFrame, pickFrameNear } from "@/lib/vision/reference-frame";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { downloadToFile } from "@/lib/storage/r2";
import { probeVideo } from "@/lib/video/ffmpeg";
import type { PreAnalysisSetup, SetupBox } from "@/lib/db/setup";
import { PARTNER_SEED_LABEL } from "@/lib/db/setup";

const execFileAsync = promisify(execFile);

export interface ReferenceFrameImage {
  mimeType: string;
  dataBase64: string;
  /** For the log line, so a wrong subject is diagnosable from a run. */
  timestampSeconds: number;
  playerLabel: string;
  /**
   * Whether a PARTNER mark was actually drawn on this image.
   *
   * REPORTED, NOT INFERRED FROM THE TAG. Having tagged a partner and having a
   * cyan ring on this frame are different facts: the frame is picked for
   * having the most players in it, not all of them. The prompt is written from
   * THIS, because a prompt that describes a mark which is not there sends the
   * model looking for it and gets its absence reported back as a finding about
   * the footage -- which has already happened once here, with the gold box.
   */
  markedPartner: boolean;
}

/**
 * The marked frame, or null with the reason logged.
 *
 * NEVER THROWS. A coaching run that dies because a still would not render is a
 * worse outcome than one that runs without it and says so -- the read is still
 * worth having, minus the part addressed to one person.
 */
/**
 * Where the marked still lives, derived rather than stored in a column.
 *
 * One deterministic path per analysis, overwritten on every coaching run, so
 * the picture on the page is always the one the last run actually sent. A
 * column would need a migration and could go stale against the file.
 */
export function referenceFramePath(userId: string, analysisId: string): string {
  return `${userId}/${analysisId}/reference/marked.jpg`;
}

export async function buildReferenceFrameImage(opts: {
  supabase: SupabaseClient<Database>;
  analysisId: string;
  /** Owner of the analysis; the storage layout is per user. */
  userId: string;
  /** Comma-separated labels as stored on the analysis; the first is used. */
  selfPlayerLabel: string | null;
  /**
   * The partner's track label, when they tagged one on the setup frame.
   *
   * Marked in a different colour rather than left to inference. The
   * partnership read is about two named people, and a model given one mark on
   * a doubles court has to pick the partner out of three candidates -- which
   * it will do, silently, and write a confident section about the wrong one.
   */
  partnerPlayerLabel?: string | null;
  /**
   * The setup row and the clip, for drawing the ring where the user TAPPED.
   *
   * Preferred over everything below whenever the tap was on a detected box:
   * the still is then the setup frame itself, cut from the source video, with
   * the ring drawn from the box the user chose. No tracking sits between the
   * tap and the ring, so nothing can move it onto somebody else.
   */
  setup?: PreAnalysisSetup | null;
  sourceKey?: string | null;
  onLog?: (line: string) => void;
}): Promise<ReferenceFrameImage | null> {
  const log = opts.onLog ?? (() => {});
  const label = (opts.selfPlayerLabel ?? "").split(",").map((l) => l.trim()).filter(Boolean)[0];

  const fromTap = await stillFromSetupTap(opts, label ?? "you", log);
  if (fromTap) return fromTap;
  if (!label) {
    log("reference frame: nobody is tagged as the subject — the model will not be told who to coach");
    return null;
  }

  const [framesRes, tracksRes] = await Promise.all([
    opts.supabase.from("analysis_frames").select("timestamp_s, debug_storage_path")
      .eq("analysis_id", opts.analysisId).order("timestamp_s"),
    opts.supabase.from("player_tracks").select("player_label, points").eq("analysis_id", opts.analysisId),
  ]);
  if (framesRes.error || tracksRes.error) {
    log(`reference frame: could not read the stored frames — ${(framesRes.error ?? tracksRes.error)!.message}`);
    return null;
  }

  // NEAR THE TAP FIRST. See pickFrameNear: the setup instant is where the
  // label was matched to the person the user chose, so a frame there shows the
  // right person under it; the fullest frame mid-clip may not.
  const setupT = opts.setup?.players.some((p) => p.isSelf) ? opts.setup.frameTimestampSeconds : null;
  const picked = (setupT !== null
    ? pickFrameNear(framesRes.data ?? [], tracksRes.data ?? [], label, setupT)
    : null) ?? pickReferenceFrame(framesRes.data ?? [], tracksRes.data ?? []);
  if (!picked) {
    log("reference frame: no rendered frame was stored for this analysis");
    return null;
  }
  const mine = picked.boxes.find((b) => b.playerLabel === label);
  const partnerLabel = opts.partnerPlayerLabel?.trim() || null;
  const theirs = partnerLabel
    ? picked.boxes.find((b) => b.playerLabel === partnerLabel)
    : undefined;
  if (!mine) {
    // THE FRAME AND THE TAG DISAGREE, which is a real possibility rather than a
    // defensive branch: the frame is chosen for having the MOST players in it,
    // not all of them, and a subject hidden behind their partner at that
    // instant has no box to mark.
    log(`reference frame: ${label} is not visible at ${picked.frame.timestamp_s.toFixed(1)}s, `
      + `the fullest frame in the clip — cannot mark them`);
    return null;
  }

  const dir = await mkdtemp(path.join(tmpdir(), "refframe-"));
  try {
    const { data, error } = await opts.supabase.storage
      .from("videos").download(picked.frame.debug_storage_path!);
    if (error || !data) {
      log(`reference frame: could not download ${picked.frame.debug_storage_path} — ${error?.message ?? "no data"}`);
      return null;
    }
    const inPath = path.join(dir, "frame.jpg");
    const outPath = path.join(dir, "marked.jpg");
    await writeFile(inPath, Buffer.from(await data.arrayBuffer()));
    const marks: FrameMark[] = [{ box: mine.box, label: "YOU" }];
    // ONLY WHEN THEY ARE ACTUALLY ON THIS FRAME. The frame is chosen for
    // having the most players in it, not all of them, so a partner standing
    // behind somebody at that instant has no box -- and a mark drawn from a
    // stale box would point the partnership read at empty court.
    if (theirs) marks.push({ box: theirs.box, label: "PARTNER" });
    else if (partnerLabel) {
      log(`reference frame: partner ${partnerLabel} is not visible at `
        + `${picked.frame.timestamp_s.toFixed(1)}s, so only you are marked`);
    }
    await markPlayersOnFrameViaPython({ imagePath: inPath, outPath, marks });
    const bytes = await readFile(outPath);
    // KEPT, NOT JUST SENT. This image is the whole of what the model is told
    // about who it is coaching, and until it was stored there was no way for
    // anyone to see it -- it was built in a temp directory, base64'd into a
    // request and deleted. When a read is addressed to the wrong person, this
    // is the first thing worth looking at, and "you cannot look at it" is not
    // an acceptable answer for the one input that decides the subject.
    //
    // Best-effort: a failed upload must not cost the run its reference frame,
    // which is still in hand as bytes either way.
    const storagePath = referenceFramePath(opts.userId, opts.analysisId);
    const { error: upErr } = await opts.supabase.storage
      .from("videos").upload(storagePath, bytes, { contentType: "image/jpeg", upsert: true });
    if (upErr) log(`reference frame: kept in memory but not stored — ${upErr.message}`);
    log(`reference frame: ${label} marked at ${picked.frame.timestamp_s.toFixed(1)}s `
      + (theirs ? `· partner ${partnerLabel} marked ` : "")
      + `(${picked.boxes.length} player(s) in frame, ${Math.round(bytes.length / 1024)}KB)`);
    return {
      mimeType: "image/jpeg",
      dataBase64: bytes.toString("base64"),
      timestampSeconds: picked.frame.timestamp_s,
      playerLabel: label,
      markedPartner: Boolean(theirs),
    };
  } catch (e) {
    log(`reference frame: could not be built — ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The setup frame, cut from the source, ringed where the user tapped.
 *
 * Null (and the caller falls back to the tracked frames) when there is no
 * tapped box -- a hand-placed mark or an old setup row -- or when anything
 * about cutting the frame fails. Never throws.
 */
async function stillFromSetupTap(
  opts: { supabase: SupabaseClient<Database>; analysisId: string; userId: string;
          setup?: PreAnalysisSetup | null; sourceKey?: string | null },
  label: string,
  log: (line: string) => void,
): Promise<ReferenceFrameImage | null> {
  const setup = opts.setup;
  const self = setup?.players.find((p) => p.isSelf);
  if (!setup || !self?.box || !opts.sourceKey) return null;
  const W = setup.frameWidthPx, H = setup.frameHeightPx;
  if (!(W > 0 && H > 0)) return null;
  const partner = setup.players.find((p) => !p.isSelf && p.label === PARTNER_SEED_LABEL && p.box);
  const norm = (b: SetupBox) => ({ x: b.x / W, y: b.y / H, width: b.width / W, height: b.height / H });

  const dir = await mkdtemp(path.join(tmpdir(), "refsetup-"));
  try {
    const src = path.join(dir, "source.mp4");
    const inPath = path.join(dir, "frame.jpg");
    const outPath = path.join(dir, "marked.jpg");
    await downloadToFile(opts.sourceKey, src);
    const t = Math.max(0, setup.frameTimestampSeconds);
    await execFileAsync("ffmpeg", [
      "-v", "error", "-ss", t.toFixed(3), "-i", src, "-frames:v", "1",
      "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", "-y", inPath,
    ]);
    // THE SAME PICTURE THE USER TAPPED ON, checked rather than assumed: a
    // rotated clip read one way by the browser and the other by ffmpeg would
    // put the ring on empty court with total confidence.
    const probed = await probeVideo(inPath);
    if (!probed.width || !probed.height
      || Math.abs(probed.width / probed.height - W / H) > 0.02 * (W / H)) {
      log(`reference frame: setup still is ${probed.width}x${probed.height}, tap was on ${W}x${H} — using tracked frames`);
      return null;
    }
    const marks: FrameMark[] = [{ box: norm(self.box), label: "YOU" }];
    if (partner?.box) marks.push({ box: norm(partner.box), label: "PARTNER" });
    await markPlayersOnFrameViaPython({ imagePath: inPath, outPath, marks });
    const bytes = await readFile(outPath);
    const storagePath = referenceFramePath(opts.userId, opts.analysisId);
    const { error: upErr } = await opts.supabase.storage
      .from("videos").upload(storagePath, bytes, { contentType: "image/jpeg", upsert: true });
    if (upErr) log(`reference frame: kept in memory but not stored — ${upErr.message}`);
    log(`reference frame: the setup frame at ${t.toFixed(1)}s, ringed where you tapped`
      + (partner ? " · partner ringed too" : ""));
    return {
      mimeType: "image/jpeg",
      dataBase64: bytes.toString("base64"),
      timestampSeconds: t,
      playerLabel: label,
      markedPartner: Boolean(partner),
    };
  } catch (e) {
    log(`reference frame: could not cut the setup frame — ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
