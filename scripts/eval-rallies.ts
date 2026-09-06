/**
 * Scores clusterRalliesFromMotion's rally boundaries against hand-labeled
 * ground truth, and (optionally) searches for better MOTION_CLUSTER_PARAMS
 * across every labeled clip at once -- so tuning is driven by a real number
 * instead of eyeballing one video. This app ships two rally-boundary
 * stages now, both scored here: clusterRalliesFromMotion finds the raw
 * window from player movement, then contactSearchWindows/restretchToHits
 * (rallies.ts) widen it and snap to any ball hit near the edge, the same
 * two-pass scan run-vision-pipeline.ts/recompute.ts do -- so this scores
 * what actually ships, not just the first stage of it. Methodology
 * mirrors the earlier Python spike's (spikes/rally-segmentation-README.md):
 * jump accuracy (did some predicted rally start within JUMP_TOLERANCE_S of
 * the true start) and F1 on interval overlap, scored on the WORST clip, not
 * the average -- a parameter set that's great on two videos and useless on
 * the third isn't one you can ship.
 *
 * Ground truth for a clip lives at shot-results/<clip>/truth.json:
 *   [[startS, endS], [startS, endS], ...]   (seconds, one per real rally)
 *
 * Usage:
 *   npx tsx scripts/eval-rallies.ts shot-results/<clip1> [shot-results/<clip2> ...]
 *   npx tsx scripts/eval-rallies.ts --search shot-results/<clip1> [...]
 *
 * --search runs a greedy per-parameter search starting from the current
 * MOTION_CLUSTER_PARAMS and prints the best config found (it does not edit
 * rallies.ts for you -- copy the printed values in yourself once you're
 * happy, so a bad search never silently overwrites a working config).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { clusterRalliesFromMotion, contactSearchWindows, restretchToHits, clusterRalliesFromHits, MOTION_CLUSTER_PARAMS, HIT_CLUSTER_PARAMS, type MotionClusterParams, type HitClusterParams } from "../src/lib/vision/rallies";
import type { CourtFrame } from "../src/lib/vision/shots";
import type { CourtCalibration, PlayerTrack } from "../src/lib/vision/phase2-types";
import { detectHits, sliceTrack, type BallTrackPoint } from "../src/lib/vision/ball";

const JUMP_TOLERANCE_S = 1.5;
const IOU_MATCH_THRESHOLD = 0.5;

interface ClipData {
  name: string;
  tracks: PlayerTrack[];
  durationSeconds: number;
  contacts: number[];
  ballPoints: BallTrackPoint[];
  truth: [number, number][];
  quadKind: CourtFrame["kind"] | null;
}

async function loadClip(dir: string): Promise<ClipData> {
  const tracks = JSON.parse(await fs.readFile(path.join(dir, "tracks.json"), "utf8")) as PlayerTrack[];
  const ball = JSON.parse(await fs.readFile(path.join(dir, "ball.json"), "utf8")) as {
    contacts: number[];
    points: BallTrackPoint[];
    durationSeconds?: number;
    calibration?: CourtCalibration;
  };
  const truthRaw = JSON.parse(await fs.readFile(path.join(dir, "truth.json"), "utf8")) as [number, number][];
  const durationSeconds =
    ball.durationSeconds ??
    Math.max(0, ...tracks.flatMap((t) => t.points.map((p) => p.timestampSeconds)), ...ball.contacts, ...ball.points.map((p) => p.t)) + 5;
  return {
    name: path.basename(dir),
    tracks,
    durationSeconds,
    contacts: ball.contacts,
    ballPoints: ball.points,
    truth: [...truthRaw].sort((a, b) => a[0] - b[0]),
    quadKind: ball.calibration?.quadKind ?? null,
  };
}

function iou(a: [number, number], b: [number, number]): number {
  const interStart = Math.max(a[0], b[0]);
  const interEnd = Math.min(a[1], b[1]);
  const inter = Math.max(0, interEnd - interStart);
  const union = a[1] - a[0] + (b[1] - b[0]) - inter;
  return union > 0 ? inter / union : 0;
}

interface ClipScore {
  name: string;
  predictedCount: number;
  truthCount: number;
  jumpAccuracy: number;
  precision: number;
  recall: number;
  f1: number;
}

function scoreClip(clip: ClipData, params: MotionClusterParams): ClipScore {
  const motionRallies = clusterRalliesFromMotion(clip.tracks, clip.durationSeconds, params, clip.quadKind);
  // Second pass, same as production: widen past each rally's edge, look
  // for a ball hit in that wider slice, snap the boundary to cover it.
  const searchWindows = contactSearchWindows(motionRallies, clip.durationSeconds);
  const stretched = motionRallies.map((r, i) => {
    const sw = searchWindows[i];
    const wideHits = detectHits(sliceTrack(clip.ballPoints, sw.searchStartS, sw.searchEndS), clip.tracks);
    return restretchToHits(r, wideHits.map((h) => h.t), sw, params.leadS, params.tailS);
  });
  const predIntervals: [number, number][] = stretched.map((r) => [r.startS, r.endS]);
  return scoreIntervals(clip, predIntervals);
}

// Ball-hits-primary: scan the WHOLE clip's ball track once for hits, then
// group hits directly into rallies -- no player speed involved at all.
function scoreClipByHits(clip: ClipData, params: HitClusterParams): ClipScore {
  const hits = detectHits(clip.ballPoints, clip.tracks);
  const rallies = clusterRalliesFromHits(
    hits.map((h) => h.t),
    clip.durationSeconds,
    params
  );
  const predIntervals: [number, number][] = rallies.map((r) => [r.startS, r.endS]);
  return scoreIntervals(clip, predIntervals);
}

function scoreIntervals(clip: ClipData, predIntervals: [number, number][]): ClipScore {
  // Jump accuracy: for each TRUE rally, did some predicted rally start
  // within JUMP_TOLERANCE_S of the true start? This is the product metric
  // -- it's what decides whether "next rally" lands the player where they
  // expect, even if the predicted window's exact shape is imperfect.
  let jumps = 0;
  for (const [ts] of clip.truth) {
    if (predIntervals.some(([ps]) => Math.abs(ps - ts) <= JUMP_TOLERANCE_S)) jumps += 1;
  }
  const jumpAccuracy = clip.truth.length > 0 ? jumps / clip.truth.length : 1;

  // F1 on interval overlap -- greedy one-to-one matching by best IoU.
  const usedPred = new Set<number>();
  let matched = 0;
  for (const t of clip.truth) {
    let bestIdx = -1;
    let bestIoU = 0;
    for (let i = 0; i < predIntervals.length; i++) {
      if (usedPred.has(i)) continue;
      const score = iou(t, predIntervals[i]);
      if (score > bestIoU) {
        bestIoU = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestIoU >= IOU_MATCH_THRESHOLD) {
      usedPred.add(bestIdx);
      matched += 1;
    }
  }
  const precision = predIntervals.length > 0 ? matched / predIntervals.length : 0;
  const recall = clip.truth.length > 0 ? matched / clip.truth.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { name: clip.name, predictedCount: predIntervals.length, truthCount: clip.truth.length, jumpAccuracy, precision, recall, f1 };
}

function printScores(scores: ClipScore[]) {
  for (const s of scores) {
    console.log(
      `  ${s.name}: ${s.predictedCount} predicted vs ${s.truthCount} real · jump ${(s.jumpAccuracy * 100).toFixed(0)}% · precision ${(s.precision * 100).toFixed(0)}% · recall ${(s.recall * 100).toFixed(0)}% · F1 ${s.f1.toFixed(3)}`
    );
  }
  const worstF1 = Math.min(...scores.map((s) => s.f1));
  const avgF1 = scores.reduce((a, s) => a + s.f1, 0) / scores.length;
  const worstJump = Math.min(...scores.map((s) => s.jumpAccuracy));
  console.log(`  -> worst-clip F1 ${worstF1.toFixed(3)} · avg F1 ${avgF1.toFixed(3)} · worst-clip jump accuracy ${(worstJump * 100).toFixed(0)}%`);
}

// Candidate values tried per parameter during --search. Deliberately a
// modest list, not a fine sweep -- with only a couple of labeled clips, a
// large grid mostly overfits to them rather than finding a genuinely
// better general setting.
const SEARCH_SPACE: Record<keyof MotionClusterParams, number[]> = {
  bucketS: [0.5],
  activeSpeedCourt: [0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0],
  activeSpeedImage: [0.08, 0.1, 0.12, 0.15, 0.18],
  gapS: [1.0, 1.5, 2.0, 2.5, 3.0, 3.5],
  minDurationS: [1.0, 1.5, 2.0],
  leadS: [0.3, 0.5, 0.8],
  tailS: [0.5, 0.8, 1.2],
};

function worstClipF1(clips: ClipData[], params: MotionClusterParams): number {
  return Math.min(...clips.map((c) => scoreClip(c, params).f1));
}

const HIT_SEARCH_SPACE: Record<keyof HitClusterParams, number[]> = {
  hitGapS: [2, 2.5, 3, 3.5, 4, 5, 6, 7, 8],
  leadS: [0.5, 0.8, 1, 1.5],
  tailS: [0.8, 1, 1.5, 2, 2.5],
};

function worstClipF1Hits(clips: ClipData[], params: HitClusterParams): number {
  return Math.min(...clips.map((c) => scoreClipByHits(c, params).f1));
}

function searchHits(clips: ClipData[]): HitClusterParams {
  let best: HitClusterParams = { ...HIT_CLUSTER_PARAMS };
  let bestScore = worstClipF1Hits(clips, best);
  console.log(`starting point (hits): worst-clip F1 ${bestScore.toFixed(3)}`);

  const keys = Object.keys(HIT_SEARCH_SPACE) as (keyof HitClusterParams)[];
  for (let pass = 0; pass < 3; pass++) {
    let improvedThisPass = false;
    for (const key of keys) {
      let localBest = best[key];
      let localBestScore = bestScore;
      for (const candidate of HIT_SEARCH_SPACE[key]) {
        const trial = { ...best, [key]: candidate };
        const score = worstClipF1Hits(clips, trial);
        if (score > localBestScore) {
          localBestScore = score;
          localBest = candidate;
        }
      }
      if (localBest !== best[key]) {
        console.log(`  pass ${pass + 1}: ${key} ${best[key]} -> ${localBest} (worst-clip F1 ${bestScore.toFixed(3)} -> ${localBestScore.toFixed(3)})`);
        best = { ...best, [key]: localBest };
        bestScore = localBestScore;
        improvedThisPass = true;
      }
    }
    if (!improvedThisPass) break;
  }
  console.log(`final (hits): worst-clip F1 ${bestScore.toFixed(3)}`);
  return best;
}

function search(clips: ClipData[]): MotionClusterParams {
  let best: MotionClusterParams = { ...MOTION_CLUSTER_PARAMS };
  let bestScore = worstClipF1(clips, best);
  console.log(`starting point: worst-clip F1 ${bestScore.toFixed(3)}`);

  const keys = Object.keys(SEARCH_SPACE) as (keyof MotionClusterParams)[];
  for (let pass = 0; pass < 3; pass++) {
    let improvedThisPass = false;
    for (const key of keys) {
      let localBest = best[key];
      let localBestScore = bestScore;
      for (const candidate of SEARCH_SPACE[key]) {
        const trial = { ...best, [key]: candidate };
        const score = worstClipF1(clips, trial);
        if (score > localBestScore) {
          localBestScore = score;
          localBest = candidate;
        }
      }
      if (localBest !== best[key]) {
        console.log(`  pass ${pass + 1}: ${key} ${best[key]} -> ${localBest} (worst-clip F1 ${bestScore.toFixed(3)} -> ${localBestScore.toFixed(3)})`);
        best = { ...best, [key]: localBest };
        bestScore = localBestScore;
        improvedThisPass = true;
      }
    }
    if (!improvedThisPass) break;
  }
  console.log(`final: worst-clip F1 ${bestScore.toFixed(3)}`);
  return best;
}

async function main() {
  const args = process.argv.slice(2);
  const doSearch = args.includes("--search");
  const dirs = args.filter((a) => a !== "--search");
  if (dirs.length === 0) {
    console.error("usage: npx tsx scripts/eval-rallies.ts [--search] <shot-results-dir> [more dirs...]");
    console.error("each dir needs a truth.json: [[startS,endS], ...]");
    process.exit(1);
  }

  const clips = await Promise.all(dirs.map(loadClip));

  console.log("player-motion clustering (clusterRalliesFromMotion + restretch, current production):");
  printScores(clips.map((c) => scoreClip(c, MOTION_CLUSTER_PARAMS)));

  console.log("\nball-hits clustering (clusterRalliesFromHits -- candidate replacement):");
  printScores(clips.map((c) => scoreClipByHits(c, HIT_CLUSTER_PARAMS)));

  if (doSearch) {
    console.log("\nsearching (player-motion params)...");
    const best = search(clips);
    console.log("\nbest player-motion params found:");
    console.log(JSON.stringify(best, null, 2));
    console.log("\nwith that config:");
    printScores(clips.map((c) => scoreClip(c, best)));

    console.log("\nsearching (ball-hits params)...");
    const bestHits = searchHits(clips);
    console.log("\nbest ball-hits params found:");
    console.log(JSON.stringify(bestHits, null, 2));
    console.log("\nwith that config:");
    printScores(clips.map((c) => scoreClipByHits(c, bestHits)));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
