import assert from "node:assert/strict";
import test from "node:test";

import {
  normaliseLineColor, playersForMode, rallySegOverridesForSetup,
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
