/**
 * Re-run hit/bounce detection and the shot classifier from a previous
 * run-shots.ts output — no video, no models, no network. This is the
 * tuning loop: change THRESHOLDS (or ball.ts), run this, run eval-shots.ts,
 * repeat. Seconds instead of minutes.
 *
 *   npx tsx scripts/reclassify-shots.ts shot-results/<clip>
 *
 * Rewrites shots.json and refreshes the `predicted` column of labels.csv
 * (keeping any `truth` you've already filled in).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { detectBounces, detectHits, sliceTrack, type BallHit, type BallTrackPoint } from "../src/lib/vision/ball";
import { classifyRally, courtFrameFor, type Shot } from "../src/lib/vision/shots";
import { clusterRalliesFromHits, HIT_CLUSTER_PARAMS } from "../src/lib/vision/rallies";
import type { CourtCalibration, PlayerTrack } from "../src/lib/vision/phase2-types";

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: npx tsx scripts/reclassify-shots.ts <shot-results dir>");
    process.exit(1);
  }
  const ball = JSON.parse(await fs.readFile(path.join(dir, "ball.json"), "utf8")) as {
    calibration: CourtCalibration;
    frameWidthPx: number;
    frameHeightPx: number;
    contacts: number[];
    points: BallTrackPoint[];
    durationSeconds?: number;
  };
  const tracks = JSON.parse(await fs.readFile(path.join(dir, "tracks.json"), "utf8")) as PlayerTrack[];
  // Older ball.json dumps (from before rallies moved to motion) have no
  // durationSeconds — fall back to the latest timestamp seen anywhere.
  const durationSeconds =
    ball.durationSeconds ??
    Math.max(
      0,
      ...tracks.flatMap((t) => t.points.map((p) => p.timestampSeconds)),
      ...ball.contacts,
      ...ball.points.map((p) => p.t)
    ) + 5;
  // Rally boundaries come from ball hits, not player motion (see
  // clusterRalliesFromHits, rallies.ts) -- rescan the cached ball track
  // for hits rather than trusting ball.contacts, which on an old dump may
  // predate this tuning loop's current detectHits constants.
  const allHitsWide = detectHits(ball.points, tracks);
  const rallies = clusterRalliesFromHits(allHitsWide.map((h) => h.t), durationSeconds, HIT_CLUSTER_PARAMS);
  const ctx = {
    calibration: ball.calibration,
    frame: courtFrameFor(ball.calibration.quadKind),
    frameWidthPx: ball.frameWidthPx,
    frameHeightPx: ball.frameHeightPx,
    playerTracks: tracks,
  };
  const shots: Shot[] = [];
  const hitsByRally = new Map<number, BallHit[]>();
  let bounceCount = 0;
  for (const r of rallies) {
    const pts = sliceTrack(ball.points, r.startS - 0.3, r.endS + 0.3);
    const hits = detectHits(pts, tracks);
    const bounces = detectBounces(pts, hits.map((h) => h.t));
    hitsByRally.set(r.idx, hits);
    bounceCount += bounces.length;
    shots.push(...classifyRally({ rallyIdx: r.idx, startS: r.startS, endS: r.endS, hits, bounces, ballPoints: pts }, ctx));
  }
  await fs.writeFile(path.join(dir, "shots.json"), JSON.stringify(shots, null, 2));

  // Refresh predictions in labels.csv without losing hand labels.
  const labelsPath = path.join(dir, "labels.csv");
  const truth = new Map<string, string>();
  try {
    const lines = (await fs.readFile(labelsPath, "utf8")).trim().split("\n");
    const h = lines[0].split(",");
    const iR = h.indexOf("rally_idx"), iS = h.indexOf("shot_idx"), iT = h.indexOf("truth");
    for (const l of lines.slice(1)) {
      const c = l.split(",");
      if (c[iT]) truth.set(`${c[iR]}/${c[iS]}`, c[iT]);
    }
  } catch {
    /* no labels yet */
  }
  const csv = ["rally_idx,shot_idx,t_s,player,predicted,confidence,truth"]
    .concat(shots.map((s) => [s.rallyIdx, s.shotIdx, s.t, s.playerId ?? "", s.type, s.confidence, truth.get(`${s.rallyIdx}/${s.shotIdx}`) ?? ""].join(",")))
    .join("\n");
  await fs.writeFile(labelsPath, csv);

  const counts: Record<string, number> = {};
  for (const s of shots) counts[s.type] = (counts[s.type] ?? 0) + 1;
  console.log(`${rallies.length} rallies · ${shots.length} shots · ${bounceCount} bounces · frame=${ctx.frame.kind}`);
  console.log(counts);

  // Actual boundaries -- this is what you check against the real video to
  // judge whether HIT_CLUSTER_PARAMS (src/lib/vision/rallies.ts) needs
  // adjusting: seek the source clip to each mm:ss and see whether that's
  // really where the point started/ended.
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  console.log("\nrally boundaries:");
  for (const r of rallies) {
    console.log(`  #${r.idx}  ${mmss(r.startS)} -> ${mmss(r.endS)}  (${(r.endS - r.startS).toFixed(1)}s, ${(hitsByRally.get(r.idx) ?? []).length} ball-detected contacts)`);
  }
  console.log(`landing known: ${shots.filter((s) => s.landingZone !== "unknown").length} · hit zone known: ${shots.filter((s) => s.hitZone !== "unknown").length} · with speed: ${shots.filter((s) => s.speedMpsApprox !== null).length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
