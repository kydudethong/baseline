import assert from "node:assert/strict";
import test from "node:test";

import {
  isCompleteSetup, normaliseLineColor, playersForMode, rallySegOverridesForSetup,
  type PreAnalysisSetup,
} from "./setup";

function setup(over: Partial<PreAnalysisSetup> = {}): PreAnalysisSetup {
  return {
    frameTimestampSeconds: 5,
    frameWidthPx: 1920,
    frameHeightPx: 1080,
    court: null,
    players: [],
    lineColorHex: null,
    matchMode: "doubles",
    savedAt: new Date().toISOString(),
    ...over,
  };
}

test("a hex colour is normalised to lowercase six digits", () => {
  assert.equal(normaliseLineColor("#1A5AC8"), "#1a5ac8");
  assert.equal(normaliseLineColor("1a5ac8"), "#1a5ac8");
  assert.equal(normaliseLineColor("  #ABC  "), "#aabbcc");
});

test("anything that is not a colour becomes null rather than throwing", () => {
  // A colour is a hint to the court fitter. Losing the hint should cost the
  // run its hint, not the run.
  for (const bad of ["", "   ", "white", "#12345", "#zzzzzz", null, undefined, 42, {}]) {
    assert.equal(normaliseLineColor(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("doubles is four players and singles is two", () => {
  assert.equal(playersForMode("doubles"), 4);
  assert.equal(playersForMode("singles"), 2);
});

test("an unknown or missing mode counts as doubles", () => {
  // Doubles is both the commoner game and the safer default: it expects four
  // and the tracker prunes down, where guessing singles would cap a doubles
  // match at two players.
  assert.equal(playersForMode(null), 4);
  assert.equal(playersForMode(undefined), 4);
});

test("a default setup overrides nothing", () => {
  // The point of this one: an empty override is NOT harmless. Passing
  // court.line_color_hex= would put the fitter on the colour path with an
  // unparseable colour, losing the white default it is meant to preserve.
  assert.deepEqual(rallySegOverridesForSetup(setup()), []);
  assert.deepEqual(rallySegOverridesForSetup(null), []);
});

test("a sampled colour becomes a court override", () => {
  assert.deepEqual(
    rallySegOverridesForSetup(setup({ lineColorHex: "#1A5AC8" })),
    [["court.line_color_hex", "#1a5ac8"]]
  );
});

test("a malformed stored colour is dropped, not passed through", () => {
  assert.deepEqual(rallySegOverridesForSetup(setup({ lineColorHex: "bright blue" })), []);
});

test("singles caps the player count and doubles leaves the default alone", () => {
  assert.deepEqual(
    rallySegOverridesForSetup(setup({ matchMode: "singles" })),
    [["players.max_players", "2"]]
  );
  assert.deepEqual(rallySegOverridesForSetup(setup({ matchMode: "doubles" })), []);
});

test("colour and mode combine", () => {
  assert.deepEqual(
    rallySegOverridesForSetup(setup({ lineColorHex: "#ebd228", matchMode: "singles" })),
    [["court.line_color_hex", "#ebd228"], ["players.max_players", "2"]]
  );
});

const COURT = {
  nearLeft: { x: 100, y: 900 }, nearRight: { x: 1800, y: 900 },
  farRight: { x: 1400, y: 320 }, farLeft: { x: 500, y: 320 },
  quadKind: "full" as const,
};

test("a setup with a court is enough to analyse", () => {
  // AND A PLAYER LIST IS NOT REQUIRED, which is the change. It used to be, and
  // keeping that bar after the players moved to after the analysis would block
  // every run on a question the setup screen no longer asks -- an analysis that
  // can never start, with the fix nowhere on screen.
  assert.equal(isCompleteSetup(setup({ court: COURT, players: [] })), true);
});

test("a setup with no court is refused, however much else it has", () => {
  // Nothing detects a court now, so without one there is no scale: no distance
  // covered, no kitchen-line time, no zones.
  assert.equal(isCompleteSetup(setup({ court: null, players: [] })), false);
  assert.equal(
    isCompleteSetup(setup({ court: null, lineColorHex: "#ffffff", matchMode: "singles" })),
    false,
    "a line colour and a match mode are settings, not a court"
  );
});

test("no setup at all is refused rather than thrown at", () => {
  assert.equal(isCompleteSetup(null), false);
});

test("an old setup's marked players neither help nor hinder", () => {
  // Rows saved before the players moved still carry them. They are ignored on
  // both sides: they cannot substitute for a court, and they cannot disqualify
  // one either.
  const legacy = [{ x: 10, y: 20, isSelf: true }, { x: 30, y: 40, isSelf: false }];
  assert.equal(isCompleteSetup(setup({ court: null, players: legacy })), false);
  assert.equal(isCompleteSetup(setup({ court: COURT, players: legacy })), true);
});
