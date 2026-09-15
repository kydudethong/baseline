/**
 * Render the pipeline's own annotated video.
 *
 * Separate from rally_seg's debug render, and for a reason worth stating: that
 * one draws rally_seg's court, rally_seg's ball track and rally_seg's rally
 * boundaries. Once the net-crossing segmenter became the one that decides the
 * answer, rally_seg's video became a picture of a component that no longer
 * decides anything -- plausible, detailed, and about something else. When the
 * numbers and the video disagree there is no way to tell which is lying.
 *
 * So this renders what was actually used, and nothing else.
 *
 * Never throws. A missing overlay is a missing overlay; it must not be able to
 * fail an analysis that otherwise succeeded.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { debugVideoDir, debugVideoKey, overlayDataKey, shotClipKey } from "./debug-video-store";

import { renderOverlayViaPython } from "./cv-scripts";
import type { BallTrackPoint } from "./ball";
import type { NetBand, NetCrossing } from "./rallies-net";
import type { ClusteredRally } from "./rallies";
import type { CourtCalibration, PlayerPoseFrame, PlayerTrack } from "./phase2-types";
import { visibleBones } from "./skeleton";

/**
 * The overlay renders on every run now, because the coaching read is written
 * from it.
 *
 * It used to be opt-in behind RALLY_SEG_DEBUG -- reasonable when it was a
 * thing you looked at to check the pipeline, and wrong now that it is an
 * INPUT. Production had that flag off, so a deployed run would have produced
 * no overlay and therefore no coaching at all.
 *
 * OVERLAY=off still turns it off, for a run that only wants the numbers. That
 * run cannot be coached, and run-coaching says so rather than failing oddly.
 */
export function debugRenderEnabled(): boolean {
  const v = (process.env.OVERLAY ?? process.env.RALLY_SEG_DEBUG ?? "on").toLowerCase();
  return v !== "off" && v !== "0" && v !== "false" && v !== "no";
}

// Re-exported from the storage module so there is one definition of where an
// overlay lives, and only one place to change when it stops being local.
export { debugVideoDir, debugVideoKey, LOCAL_BUCKET } from "./debug-video-store";

export interface DebugRenderInput {
  videoPath: string;
  analysisId: string;
  durationSeconds: number;
  frameWidthPx: number;
  frameHeightPx: number;
  calibration: CourtCalibration;
  netLinePx: [[number, number], [number, number]] | null;
  netBandPx: NetBand | null;
  ballGatePx: Array<[number, number]> | null;
  ballPoints: BallTrackPoint[];
  crossings: NetCrossing[];
  rallies: ClusteredRally[];
  tracks: PlayerTrack[];
  poses: PlayerPoseFrame[];
  /** playerId -> "You" / "Partner" / "Opponent 1". Optional; ids are the fallback. */
  roleNames?: Map<string, string>;
  /** Paddle boxes, when a paddle model ran — drawn so a bad model is visible, not just reported. */
  paddles?: Array<{ t: number; x: number; y: number; w?: number; h?: number; playerId: string | null; confidence: number; source?: "detected" | "pose"; angleDeg?: number }>;
  /** Contacts confirmed from audio + ball agreement, flashed on the overlay. */
  audioContacts?: Array<{ t: number; x: number; y: number; playerId: string | null }>;
  selfPlayerId: string | null;
  onLog?: (line: string) => void;
}

/**
 * Everything the renderer needs, as the JSON it reads.
 *
 * Split out from renderDebugVideo because it is written ONCE and read many
 * times: the full overlay at the end of a run, and then a short clip per
 * coaching point, possibly days later. Building it twice from two code paths
 * is how a clip and the full overlay start disagreeing about what happened.
 */
export function buildOverlayData(input: DebugRenderInput): unknown {
  const c = input.calibration.cornersImagePx;
  return {
      durationS: input.durationSeconds,
      courtCornersPx: c && input.calibration.confidence > 0
        ? [c.bottomLeft, c.bottomRight, c.topRight, c.topLeft]
        : null,
      netLinePx: input.netLinePx,
      netBandPx: input.netBandPx,
      ballGatePx: input.ballGatePx,
      // Only the trail matters, and a full track is megabytes of JSON.
      ballPoints: input.ballPoints.map((p) => ({
        t: Math.round(p.t * 1000) / 1000,
        x: Math.round(p.x * 10000) / 10000,
        y: Math.round(p.y * 10000) / 10000,
        interpolated: p.interpolated,
      })),
      crossings: input.crossings,
      rallies: input.rallies.map((r) => ({ idx: r.idx, startS: r.startS, endS: r.endS })),
      // Bones resolved here rather than in Python: one skeleton definition,
      // shared with the still-frame overlay, so the two views of the same pose
      // can never disagree about what connects to what.
      poses: input.poses.map((p) => ({
        t: Math.round(p.timestampSeconds * 1000) / 1000,
        playerId: p.playerId,
        bones: visibleBones(p.keypoints).map((b) => [
          Math.round(b.from[0] * 10000) / 10000, Math.round(b.from[1] * 10000) / 10000,
          Math.round(b.to[0] * 10000) / 10000, Math.round(b.to[1] * 10000) / 10000,
          b.group,
        ]),
        joints: p.keypoints
          .filter((k) => k.xNorm !== null && k.yNorm !== null && (k.confidence ?? 0) >= 0.3)
          .map((k) => [Math.round(k.xNorm! * 10000) / 10000, Math.round(k.yNorm! * 10000) / 10000]),
      })),
      paddles: (input.paddles ?? []).map((p) => ({
        t: Math.round(p.t * 1000) / 1000,
        x: Math.round(p.x * 10000) / 10000,
        y: Math.round(p.y * 10000) / 10000,
        w: p.w === undefined ? null : Math.round(p.w * 10000) / 10000,
        h: p.h === undefined ? null : Math.round(p.h * 10000) / 10000,
        playerId: p.playerId,
        conf: Math.round(p.confidence * 100) / 100,
        source: p.source ?? "detected",
        angleDeg: p.angleDeg ?? null,
      })),
      audioContacts: (input.audioContacts ?? []).map((c) => ({
        t: Math.round(c.t * 1000) / 1000,
        x: Math.round(c.x * 10000) / 10000,
        y: Math.round(c.y * 10000) / 10000,
      })),
      tracks: input.tracks.map((t) => ({
        playerId: t.playerId,
        // The name drawn on the box. Roles rather than track ids, because this
        // overlay is the thing the coaching model watches -- if the boxes say
        // "Partner" and "Opponent 1", the coaching that comes back says them
        // too, and the reader never has to decode "Player 3".
        label: input.roleNames?.get(t.playerId) ?? null,
        isSelf: t.playerId === input.selfPlayerId,
        points: t.points.map((p) => ({
          t: Math.round(p.timestampSeconds * 1000) / 1000,
          box: [p.boxImageNorm.x, p.boxImageNorm.y, p.boxImageNorm.width, p.boxImageNorm.height],
        })),
      })),
  };
}

/** Run the Python renderer. Shared by the full overlay and by clips. */
async function runRenderer(
  videoPath: string, dataPath: string, outPath: string,
  /** Clip length, for a timeout that scales with the work. */
  durationSeconds: number,
  window?: { startS: number; endS: number }
): Promise<void> {
  // Through cv-scripts now rather than a bespoke execFile: that path had no
  // timeout, no abort signal and no streamed progress, which made the longest
  // stage in the pipeline the only one you could not watch, cancel or bound.
  const seconds = window ? window.endS - window.startS : durationSeconds;
  await renderOverlayViaPython(videoPath, dataPath, outPath, {
    startS: window?.startS,
    endS: window?.endS,
    // Frames at an assumed 30fps source. Only used to size the timeout, so an
    // approximation is fine and a wrong guess is generous rather than fatal.
    sourceFrames: Math.max(1, Math.round(seconds * 30)),
  });
}

export async function renderDebugVideo(input: DebugRenderInput): Promise<string | null> {
  const outDir = debugVideoDir();
  const outPath = path.join(outDir, debugVideoKey(input.analysisId));
  // The data lives beside the video rather than in a temp dir that is deleted
  // on the way out. A coaching clip is rendered from it later -- possibly much
  // later -- and re-deriving it would mean re-running the whole analysis.
  const dataPath = path.join(outDir, overlayDataKey(input.analysisId));

  try {
    await fsp.mkdir(outDir, { recursive: true });
    await fsp.writeFile(dataPath, JSON.stringify(buildOverlayData(input)), "utf8");
    await runRenderer(input.videoPath, dataPath, outPath, input.durationSeconds);
    if (!fs.existsSync(outPath)) return null;
    return `/rally-debug/${debugVideoKey(input.analysisId)}`;
  } catch (err) {
    // The WHOLE message, not the first line.
    //
    // A Python traceback puts the useful part -- the exception and its text --
    // at the END, and the first line is "Traceback (most recent call last):".
    // So the one thing this logged about the stage that fails most often was
    // reliably the least informative line available.
    input.onLog?.(`debug overlay not rendered: ${(err as Error).message}`);
    throw err;
  }
}

/** How much of the clip sits before the contact, and how much after. */
export const CLIP_LEAD_S = 1.5;
export const CLIP_TAIL_S = 1.5;

/**
 * A short overlay clip around one moment.
 *
 * Measured on a real clip: rendering the full overlay of a 20-second video
 * took 11.0 s, and a 3-second window took 0.85 s. That ratio is the whole
 * reason a coaching point can carry its own video -- five of them cost about
 * four seconds, where five full renders would cost a minute.
 *
 * Never throws. A coaching point without a clip is still a coaching point.
 */
export async function renderShotClip(opts: {
  videoPath: string;
  overlayDataPath: string;
  analysisId: string;
  atSeconds: number;
  durationSeconds: number;
  outDir?: string;
  onLog?: (line: string) => void;
}): Promise<string | null> {
  const outDir = opts.outDir ?? debugVideoDir();
  const name = shotClipKey(opts.analysisId, opts.atSeconds);
  const outPath = path.join(outDir, name);
  // Clamped to the clip. Asking ffmpeg for -1.2s produces an empty file, and
  // an empty file is worse than a shorter one: it plays as a broken video
  // rather than as a slightly clipped moment.
  const startS = Math.max(0, opts.atSeconds - CLIP_LEAD_S);
  const endS = Math.min(opts.durationSeconds, opts.atSeconds + CLIP_TAIL_S);
  if (!(endS > startS)) return null;

  try {
    await fsp.mkdir(outDir, { recursive: true });
    await runRenderer(opts.videoPath, opts.overlayDataPath, outPath, opts.durationSeconds ?? endS, { startS, endS });
    if (!fs.existsSync(outPath)) return null;
    return name;
  } catch (err) {
    opts.onLog?.(`shot clip not rendered: ${(err as Error).message.split("\n")[0]}`);
    return null;
  }
}
