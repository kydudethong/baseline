/**
 * The overlay video, as bytes, for the analyst to watch.
 *
 * The overlay used to be a debug artefact -- rendered only under
 * RALLY_SEG_DEBUG, written to the machine's local disk, and nice to have.
 * It is now an INPUT: the analyst's rally boundaries, shot types and coaching
 * all come from watching it. A run without one cannot be coached.
 *
 * Two places it can live, because the pipeline records which: R2 (survives a
 * redeploy) or the local disk of the machine that rendered it.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { downloadToFile } from "@/lib/storage/r2";
import { debugVideoDir, debugVideoKey, R2_BUCKET } from "@/lib/vision/debug-video-store";

export class OverlayMissingError extends Error {}

export async function readOverlayBytes(
  analysisId: string,
  bucket: string | null,
  storagePath: string | null
): Promise<Uint8Array> {
  if (!storagePath) {
    throw new OverlayMissingError(
      "This analysis has no annotated overlay, and the coaching read is written from one. "
      + "Re-run the analysis to render it."
    );
  }

  if (bucket === R2_BUCKET) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pb-overlay-"));
    const local = path.join(dir, debugVideoKey(analysisId));
    try {
      await downloadToFile(storagePath, local);
      return new Uint8Array(await fsp.readFile(local));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Local bucket: the file sits on the disk of whichever machine rendered it.
  // On one machine that is this one. If the app ever runs more than one, this
  // is where a coaching run starts failing for half the analyses, and the
  // error says so rather than reporting a missing file.
  const local = path.join(debugVideoDir(), path.basename(storagePath));
  try {
    return new Uint8Array(await fsp.readFile(local));
  } catch {
    throw new OverlayMissingError(
      `The overlay for this analysis was written to local disk (${path.basename(storagePath)}) and is not `
      + "here now — either the machine was replaced, or it was rendered by a different one. "
      + "Re-run the analysis."
    );
  }
}
