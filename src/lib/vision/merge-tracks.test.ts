import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTrackGroups, OVERLAP_TOLERANCE_S } from "./merge-tracks";
import type { PlayerTrack } from "./phase2-types";

/** A track occupying [from, to] at one sample a second. */
function track(playerId: string, from: number, to: number): PlayerTrack {
  const points = [];
  for (let t = from; t <= to; t += 1) {
    points.push({
      timestampSeconds: t,
      boxImageNorm: { x: 0.4, y: 0.4, width: 0.1, height: 0.2 },
      courtPosition: null,
    });
  }
  return { playerId, points } as unknown as PlayerTrack;
}

test("fragments of one person become one track", () => {
  const tracks = [track("player_1", 0, 60), track("player_7", 61, 120)];
  const { tracks: out, merged } = mergeTrackGroups(tracks, [["player_1", "player_7"]]);
  assert.equal(out.length, 1);
  assert.equal(out[0].playerId, "player_1", "the longer-lived id is the one kept");
  assert.equal(out[0].points.length, 61 + 60);
  assert.deepEqual(merged.get("player_1"), ["player_7"]);
});

test("nobody is in two places at once, whatever the model says", () => {
  // THE RULE THIS FILE EXISTS FOR. A model watching four people in similar kit
  // will sometimes group two ids that were on court together. That is not a
  // confidence judgement to weigh -- it is arithmetic, and it wins.
  const tracks = [track("player_1", 0, 60), track("player_2", 0, 60)];
  const { tracks: out, rejected } = mergeTrackGroups(tracks, [["player_1", "player_2"]]);
  assert.equal(out.length, 2, "both players survive");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /same time/);
});

test("a rejected member is kept as its own track, not lost", () => {
  // Being wrong about one pairing must not cost a player.
  const tracks = [track("player_1", 0, 60), track("player_2", 0, 60), track("player_9", 61, 90)];
  const { tracks: out } = mergeTrackGroups(tracks, [["player_1", "player_2", "player_9"]]);
  const ids = out.map((t) => t.playerId).sort();
  assert.deepEqual(ids, ["player_1", "player_2"]);
  assert.equal(out.find((t) => t.playerId === "player_1")!.points.length, 61 + 30,
    "the non-conflicting fragment still merged");
});

test("touching at a single sampled instant is not an overlap", () => {
  // The tracker's last sighting and its first re-acquisition are genuinely the
  // same moment; requiring zero overlap would refuse every real merge.
  const tracks = [track("player_1", 0, 60), track("player_7", 60, 120)];
  const { tracks: out, rejected } = mergeTrackGroups(tracks, [["player_1", "player_7"]]);
  assert.equal(rejected.length, 0, `${OVERLAP_TOLERANCE_S}s of tolerance should cover one shared sample`);
  assert.equal(out.length, 1);
});

test("unknown ids and single-member groups are no-ops", () => {
  const tracks = [track("player_1", 0, 60)];
  const { tracks: out, merged } = mergeTrackGroups(tracks, [["player_1", "ghost"], ["player_1"]]);
  assert.equal(out.length, 1);
  assert.equal(merged.size, 0);
});

test("an id cannot be folded into two different people", () => {
  const tracks = [track("player_1", 0, 30), track("player_7", 31, 60), track("player_2", 61, 90)];
  const { tracks: out } = mergeTrackGroups(tracks, [
    ["player_1", "player_7"],
    ["player_2", "player_7"],
  ]);
  const ids = out.map((t) => t.playerId).sort();
  assert.deepEqual(ids, ["player_1", "player_2"]);
});
