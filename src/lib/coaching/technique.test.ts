import { test } from "node:test";
import assert from "node:assert/strict";
import { selectTechniqueShots } from "./technique";

const shot = (t: number, player: string) => ({ t, player });

test("only the subject's shots are read", () => {
  // The change that matters most: in doubles, three quarters of the analyst's
  // shots belong to players whose technique is never coached.
  const shots = [
    shot(1, "Player 1"), shot(2, "Player 3"), shot(3, "Player 2"),
    shot(4, "Player 3"), shot(5, "Player 4"), shot(6, "Player 3"),
  ];
  const got = selectTechniqueShots(shots, 60, ["Player 3"], 10);
  assert.deepEqual(got.map((s) => s.t), [2, 4, 6]);
});

test("label formats that differ only in punctuation still match", () => {
  const shots = [shot(1, "player_3"), shot(2, "Player 1")];
  assert.deepEqual(selectTechniqueShots(shots, 60, ["Player 3"], 10).map((s) => s.t), [1]);
});

test("several labels can be the same person", () => {
  // No re-identification in the tracker, so one human can span labels.
  const shots = [shot(1, "Player 3"), shot(2, "Player 5"), shot(3, "Player 1")];
  const got = selectTechniqueShots(shots, 60, ["Player 3", "Player 5"], 10);
  assert.deepEqual(got.map((s) => s.t), [1, 2]);
});

test("a subject label that matches nothing falls back to every shot", () => {
  // Strict matching would produce a silent empty technique pass, which looks
  // identical to the model having nothing to say.
  const shots = [shot(1, "Player 1"), shot(2, "Player 2")];
  assert.equal(selectTechniqueShots(shots, 60, ["Player 9"], 10).length, 2);
});

test("no subject given means every shot, as before", () => {
  const shots = [shot(1, "Player 1"), shot(2, "Player 2")];
  assert.equal(selectTechniqueShots(shots, 60, [], 10).length, 2);
});

test("shots outside the clip are dropped", () => {
  const shots = [shot(-1, "Player 3"), shot(5, "Player 3"), shot(999, "Player 3")];
  assert.deepEqual(selectTechniqueShots(shots, 60, ["Player 3"], 10).map((s) => s.t), [5]);
});

test("results are in time order whatever order they arrived in", () => {
  const shots = [shot(9, "Player 3"), shot(2, "Player 3"), shot(5, "Player 3")];
  assert.deepEqual(selectTechniqueShots(shots, 60, ["Player 3"], 10).map((s) => s.t), [2, 5, 9]);
});

test("over the cap, shots are spread across the clip rather than taken from the front", () => {
  // The old .slice(0, max) meant every technique note on a long clip came from
  // the opening minutes.
  const shots = Array.from({ length: 100 }, (_, i) => shot(i, "Player 3"));
  const got = selectTechniqueShots(shots, 200, ["Player 3"], 5);
  assert.equal(got.length, 5);
  assert.equal(got[0].t, 0, "the first shot is included");
  assert.equal(got[got.length - 1].t, 99, "the last shot is included");
  assert.ok(got[2].t > 40 && got[2].t < 60, `the middle pick was ${got[2].t}, not near the middle`);
});

test("under the cap, everything is kept", () => {
  const shots = Array.from({ length: 4 }, (_, i) => shot(i, "Player 3"));
  assert.equal(selectTechniqueShots(shots, 60, ["Player 3"], 18).length, 4);
});

test("the spread never returns the same shot twice", () => {
  const shots = Array.from({ length: 7 }, (_, i) => shot(i, "Player 3"));
  const got = selectTechniqueShots(shots, 60, ["Player 3"], 6);
  assert.equal(new Set(got.map((s) => s.t)).size, got.length);
});

test("an empty list is empty, not a crash", () => {
  assert.deepEqual(selectTechniqueShots([], 60, ["Player 3"], 10), []);
});
