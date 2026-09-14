import { test } from "node:test";
import assert from "node:assert/strict";
import { assignRoles, roleNameMap } from "./player-roles";

const sides: Record<string, "near" | "far"> = {
  player_1: "near", player_2: "far", player_3: "near", player_4: "far",
};
const sideOf = (id: string) => sides[id] ?? null;

test("your side becomes You and Partner, the far side becomes opponents", () => {
  const got = roleNameMap(assignRoles(Object.keys(sides), ["player_3"], sideOf));
  assert.equal(got.get("player_3"), "You");
  assert.equal(got.get("player_1"), "Partner");
  assert.equal(got.get("player_2"), "Opponent 1");
  assert.equal(got.get("player_4"), "Opponent 2");
});

test("which side is 'yours' is taken from you, not assumed to be near", () => {
  // Tagging a far-side player must flip the whole assignment.
  const got = roleNameMap(assignRoles(Object.keys(sides), ["player_2"], sideOf));
  assert.equal(got.get("player_2"), "You");
  assert.equal(got.get("player_4"), "Partner");
  assert.equal(got.get("player_1"), "Opponent 1");
  assert.equal(got.get("player_3"), "Opponent 2");
});

test("label punctuation does not stop you being recognised", () => {
  const got = roleNameMap(assignRoles(Object.keys(sides), ["Player 3"], sideOf));
  assert.equal(got.get("player_3"), "You");
});

test("one person spanning two track labels is You twice, not You and Partner", () => {
  // The tracker has no re-identification, so an occlusion can resume the same
  // human under a new id. Both are tagged; both are You.
  const got = roleNameMap(assignRoles(Object.keys(sides), ["player_1", "player_3"], sideOf));
  assert.equal(got.get("player_1"), "You");
  assert.equal(got.get("player_3"), "You");
  assert.equal(got.get("player_2"), "Opponent 1");
});

test("opponent numbering is stable, not positional", () => {
  // Called twice with the ids in different orders: the same human keeps the
  // same number, so coaching about "Opponent 1" still means one person.
  const a = roleNameMap(assignRoles(["player_1", "player_2", "player_3", "player_4"], ["player_3"], sideOf));
  const b = roleNameMap(assignRoles(["player_4", "player_2", "player_1", "player_3"], ["player_3"], sideOf));
  assert.equal(a.get("player_2"), b.get("player_2"));
  assert.equal(a.get("player_4"), b.get("player_4"));
});

test("with no court, nobody is confidently mislabelled", () => {
  // A wrong "Partner" is worse than an honest "Player 2".
  const got = roleNameMap(assignRoles(Object.keys(sides), ["player_3"], () => null));
  assert.equal(got.get("player_3"), "You");
  assert.equal(got.get("player_1"), "Player 1");
  assert.equal(got.get("player_2"), "Player 2");
});

test("a player whose own side is unknown is not guessed at", () => {
  const partial = (id: string) => (id === "player_2" ? null : sideOf(id));
  const got = roleNameMap(assignRoles(Object.keys(sides), ["player_3"], partial));
  assert.equal(got.get("player_2"), "Player 2");
  assert.equal(got.get("player_4"), "Opponent 1");
});

test("nobody tagged means nobody is You", () => {
  const got = assignRoles(Object.keys(sides), [], sideOf);
  assert.equal(got.filter((a) => a.role === "self").length, 0);
  assert.ok(got.every((a) => /^Player \d$/.test(a.name)));
});

test("two tracks on your own side are both Partner, not Partner 1 and 2", () => {
  const three = { player_1: "near", player_3: "near", player_5: "near", player_2: "far" } as const;
  const got = roleNameMap(assignRoles(Object.keys(three), ["player_1"], (id) => three[id as keyof typeof three] ?? null));
  assert.equal(got.get("player_3"), "Partner");
  assert.equal(got.get("player_5"), "Partner");
});

test("singles — one opponent, no partner", () => {
  const two = { player_1: "near", player_2: "far" } as const;
  const got = roleNameMap(assignRoles(Object.keys(two), ["player_1"], (id) => two[id as keyof typeof two] ?? null));
  assert.equal(got.get("player_1"), "You");
  assert.equal(got.get("player_2"), "Opponent 1");
});
