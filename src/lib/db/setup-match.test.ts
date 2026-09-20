import test from "node:test";
import assert from "node:assert/strict";
import { matchTracksToSetup, PARTNER_SEED_LABEL, type PreAnalysisSetup } from "./setup";

const FRAME_W = 1920;
const FRAME_H = 1080;

/** A track standing at (x, y) in frame pixels, one point, at the setup frame. */
const trackAt = (playerId: string, x: number, y: number, boxH = 200) => ({
  playerId,
  points: [{
    timestampSeconds: 5,
    boxImageNorm: {
      x: (x - boxH * 0.2) / FRAME_W,
      y: (y - boxH) / FRAME_H,
      width: (boxH * 0.4) / FRAME_W,
      height: boxH / FRAME_H,
    },
  }],
});

const setupWith = (players: PreAnalysisSetup["players"]): PreAnalysisSetup => ({
  frameTimestampSeconds: 5,
  frameWidthPx: FRAME_W,
  frameHeightPx: FRAME_H,
  court: null,
  players,
  lineColorHex: null,
  matchMode: "doubles",
  savedAt: new Date(0).toISOString(),
});

test("the seed marked isSelf names you, and the partner seed names your partner", () => {
  const tracks = [trackAt("P1", 400, 900), trackAt("P2", 1200, 880), trackAt("P3", 700, 400, 90)];
  const match = matchTracksToSetup(tracks, setupWith([
    { x: 400, y: 900, isSelf: true },
    { x: 1200, y: 880, isSelf: false, label: PARTNER_SEED_LABEL },
  ]));
  assert.equal(match.selfPlayerId, "P1");
  assert.equal(match.partnerPlayerId, "P2");
});

test("every track is kept — seeds identify, they do not filter", () => {
  const tracks = [trackAt("P1", 400, 900), trackAt("P2", 1200, 880), trackAt("P3", 700, 400, 90)];
  const match = matchTracksToSetup(tracks, setupWith([{ x: 400, y: 900, isSelf: true }]));
  assert.equal(match.keep.length, 3, "dropping unmarked players takes the rallies with them");
});

test("tagging only yourself leaves the partner null rather than guessing", () => {
  const tracks = [trackAt("P1", 400, 900), trackAt("P2", 1200, 880)];
  const match = matchTracksToSetup(tracks, setupWith([{ x: 400, y: 900, isSelf: true }]));
  assert.equal(match.selfPlayerId, "P1");
  assert.equal(match.partnerPlayerId, null);
});

test("an unlabelled non-self seed is not silently treated as the partner", () => {
  // Older saved setups seeded every detected player with isSelf false. Reading
  // those as partners would name a stranger across the net as the teammate.
  const tracks = [trackAt("P1", 400, 900), trackAt("P2", 1200, 880)];
  const match = matchTracksToSetup(tracks, setupWith([
    { x: 400, y: 900, isSelf: true },
    { x: 1200, y: 880, isSelf: false },
  ]));
  assert.equal(match.partnerPlayerId, null);
});

test("two seeds cannot both land on one track", () => {
  // Marking the same person twice must not make somebody their own partner:
  // a partnership read whose subjects are one person finds perfect harmony.
  const tracks = [trackAt("P1", 400, 900)];
  const match = matchTracksToSetup(tracks, setupWith([
    { x: 400, y: 900, isSelf: true },
    { x: 402, y: 902, isSelf: false, label: PARTNER_SEED_LABEL },
  ]));
  assert.equal(match.selfPlayerId, "P1");
  assert.equal(match.partnerPlayerId, null);
});

test("a seed nowhere near anybody matches nobody", () => {
  const tracks = [trackAt("P1", 400, 900)];
  const match = matchTracksToSetup(tracks, setupWith([
    { x: 400, y: 900, isSelf: true },
    { x: 1800, y: 200, isSelf: false, label: PARTNER_SEED_LABEL },
  ]));
  assert.equal(match.selfPlayerId, "P1");
  assert.equal(match.partnerPlayerId, null);
});

test("the closest match wins, so a marginal seed cannot steal a confident one", () => {
  // P1 is right under the self seed; P2 is within tolerance of it too. If the
  // partner seed were matched first it could claim P1 and push you onto P2.
  const tracks = [trackAt("P1", 400, 900), trackAt("P2", 460, 900)];
  const match = matchTracksToSetup(tracks, setupWith([
    { x: 400, y: 900, isSelf: true },
    { x: 455, y: 900, isSelf: false, label: PARTNER_SEED_LABEL },
  ]));
  assert.equal(match.selfPlayerId, "P1");
  assert.equal(match.partnerPlayerId, "P2");
});

test("no setup at all is not an error, it is just an untagged run", () => {
  const match = matchTracksToSetup([trackAt("P1", 400, 900)], null);
  assert.equal(match.selfPlayerId, null);
  assert.equal(match.partnerPlayerId, null);
  assert.equal(match.keep.length, 1);
});

test("tolerance scales with the player's own size, not a fixed pixel count", () => {
  // A player at the far baseline is a fraction of the height of one near the
  // camera. 40 px is a miss on the small box and a hit on the large one.
  const near = matchTracksToSetup(
    [trackAt("NEAR", 400, 900, 400)],
    setupWith([{ x: 440, y: 900, isSelf: true }])
  );
  const far = matchTracksToSetup(
    [trackAt("FAR", 400, 900, 20)],
    setupWith([{ x: 440, y: 900, isSelf: true }])
  );
  assert.equal(near.selfPlayerId, "NEAR");
  assert.equal(far.selfPlayerId, null);
});
