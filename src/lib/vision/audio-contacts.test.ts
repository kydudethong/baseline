/**
 * The whole value of this gate is what it REJECTS. These clips are recorded
 * between two other games, so the test that matters most is the one where a
 * real paddle sound happens and our ball sails straight through it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmAudioContacts, newAudioGateStats, AUDIO_GATE_PARAMS, type AudioOnset, type PaddleObservation } from "./audio-contacts";
import type { BallTrackPoint } from "./ball";
import type { PlayerTrack } from "./phase2-types";

const FPS = 24;

/** A ball travelling in a straight line through `at`, toward (or past) it. */
function straight(from: { x: number; y: number }, vx: number, vy: number, t0: number, n: number): BallTrackPoint[] {
  const pts: BallTrackPoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = t0 + i / FPS;
    pts.push({ t: Math.round(t * 1000) / 1000, x: from.x + vx * (t - t0), y: from.y + vy * (t - t0), conf: 0.9, interpolated: false });
  }
  return pts;
}

/** Ball comes in, is struck at `tHit`, leaves in a new direction. */
function struck(tHit: number): BallTrackPoint[] {
  const inbound = straight({ x: 0.30, y: 0.50 }, 0.5, 0.0, tHit - 0.30, 7);
  const contact = { x: 0.30 + 0.5 * 0.30, y: 0.50 };
  const outbound = straight(contact, -0.45, -0.15, tHit + 1 / FPS, 7);
  return [...inbound, ...outbound];
}

function trackAt(id: string, x: number, y: number): PlayerTrack {
  const points = [];
  for (let i = 0; i < 60; i++) {
    points.push({
      timestampSeconds: Math.round((i / 5) * 100) / 100,
      boxImageNorm: { x: x - 0.04, y: y - 0.12, width: 0.08, height: 0.24 },
      confidence: 0.9,
      courtPosition: null,
    });
  }
  return { playerId: id, points } as PlayerTrack;
}

const onset = (t: number, strength = 0.4): AudioOnset => ({ timestampSeconds: t, strength });

test("accepts an onset where the ball really turns at a player", () => {
  const stats = newAudioGateStats();
  const hits = confirmAudioContacts({
    onsets: [onset(4.0)],
    ballPoints: struck(4.0),
    tracks: [trackAt("player_1", 0.45, 0.50)],
    stats,
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].playerId, "player_1");
  assert.equal(stats.accepted, 1);
});

test("REJECTS the next court: a loud onset while our ball sails straight through", () => {
  const stats = newAudioGateStats();
  const hits = confirmAudioContacts({
    onsets: [onset(4.0, 0.95)],           // louder than the real one above
    ballPoints: straight({ x: 0.30, y: 0.50 }, 0.5, 0.0, 3.7, 14),
    tracks: [trackAt("player_1", 0.45, 0.50)],
    stats,
  });
  assert.equal(hits.length, 0, "a ball that did not change was not hit");
  assert.equal(stats.rejectedNoChange, 1);
});

test("rejects an onset with no ball seen either side of it", () => {
  const stats = newAudioGateStats();
  const hits = confirmAudioContacts({
    onsets: [onset(40)],
    ballPoints: struck(4.0),
    tracks: [trackAt("player_1", 0.45, 0.50)],
    stats,
  });
  assert.equal(hits.length, 0);
  assert.equal(stats.rejectedNoBall, 1);
});

test("rejects a turn that happens nowhere near a player", () => {
  const stats = newAudioGateStats();
  const hits = confirmAudioContacts({
    onsets: [onset(4.0)],
    ballPoints: struck(4.0),
    tracks: [trackAt("player_1", 0.90, 0.90)],
    stats,
  });
  assert.equal(hits.length, 0);
  assert.equal(stats.rejectedNotTowardPlayer, 1);
});

test("rejects a player the ball was moving AWAY from", () => {
  // Same geometry, but the player sits behind the ball's origin, so the
  // inbound velocity is opening, not closing.
  const stats = newAudioGateStats();
  const hits = confirmAudioContacts({
    onsets: [onset(4.0)],
    ballPoints: struck(4.0),
    tracks: [trackAt("player_1", 0.28, 0.50)],
    stats,
  });
  assert.equal(hits.length, 0);
  assert.equal(stats.rejectedNotTowardPlayer, 1);
});

test("a pace change with little turn still counts — a dink kills speed", () => {
  const tHit = 4.0;
  const inbound = straight({ x: 0.30, y: 0.50 }, 0.6, 0.0, tHit - 0.3, 7);
  const contact = { x: 0.30 + 0.6 * 0.30, y: 0.50 };
  // Same heading, a quarter of the pace.
  const outbound = straight(contact, 0.15, 0.0, tHit + 1 / FPS, 7);
  const hits = confirmAudioContacts({
    onsets: [onset(tHit)],
    ballPoints: [...inbound, ...outbound],
    tracks: [trackAt("player_1", 0.50, 0.50)],
  });
  assert.equal(hits.length, 1);
});

test("does not need the ball at the instant of contact", () => {
  // Drop every observation within 0.1s of the strike, as happens when the
  // paddle and the player's body hide it.
  const pts = struck(4.0).filter((p) => Math.abs(p.t - 4.0) > 0.1);
  const hits = confirmAudioContacts({
    onsets: [onset(4.0)],
    ballPoints: pts,
    tracks: [trackAt("player_1", 0.45, 0.50)],
  });
  assert.equal(hits.length, 1);
});

test("two onsets from one strike collapse to a single contact", () => {
  const stats = newAudioGateStats();
  const hits = confirmAudioContacts({
    onsets: [onset(4.0), onset(4.05)],
    ballPoints: struck(4.0),
    tracks: [trackAt("player_1", 0.45, 0.50)],
    stats,
  });
  assert.equal(hits.length, 1);
  assert.equal(stats.rejectedSpacing, 1);
});

test("a detected paddle raises confidence but is never required", () => {
  const common = {
    onsets: [onset(4.0)],
    ballPoints: struck(4.0),
    tracks: [trackAt("player_1", 0.45, 0.50)],
  };
  const without = confirmAudioContacts(common);
  const paddles: PaddleObservation[] = [{ t: 4.0, x: 0.45, y: 0.48, playerId: "player_1", confidence: 0.8 }];
  const with_ = confirmAudioContacts({ ...common, paddles });
  assert.equal(without.length, 1);
  assert.equal(with_.length, 1);
  assert.ok(with_[0].confidence > without[0].confidence);
});

test("interpolated ball points never vouch for an onset", () => {
  const fake = struck(4.0).map((p) => ({ ...p, interpolated: true }));
  const stats = newAudioGateStats();
  const hits = confirmAudioContacts({
    onsets: [onset(4.0)], ballPoints: fake,
    tracks: [trackAt("player_1", 0.45, 0.50)], stats,
  });
  assert.equal(hits.length, 0);
  assert.equal(stats.rejectedNoBall, 1);
});

test("a velocity fitted across a long gap is not trusted", () => {
  // Two points 0.4s apart either side of the onset: that is a chord across an
  // arc, not a velocity. Measured on real footage this was letting three
  // quarters of all onsets through, which is not a filter.
  const sparse: BallTrackPoint[] = [
    { t: 3.70, x: 0.20, y: 0.50, conf: 0.9, interpolated: false },
    { t: 3.95, x: 0.40, y: 0.50, conf: 0.9, interpolated: false },
    { t: 4.05, x: 0.42, y: 0.52, conf: 0.9, interpolated: false },
    { t: 4.30, x: 0.30, y: 0.60, conf: 0.9, interpolated: false },
  ];
  const stats = newAudioGateStats();
  const hits = confirmAudioContacts({
    onsets: [onset(4.0)], ballPoints: sparse,
    tracks: [trackAt("player_1", 0.45, 0.50)], stats,
  });
  assert.equal(hits.length, 0);
  assert.equal(stats.rejectedGappy, 1);
});

/* ---- Occlusion recovery: the ball vanishes at a fast-moving player ------ */


/* ---- the ±1s window and its slack guard ---------------------------------- */

/** One ball sighting. */
const bp = (t: number, x: number, y: number): BallTrackPoint =>
  ({ t: Math.round(t * 1000) / 1000, x, y, conf: 0.9, interpolated: false });

test("the window is 0.35s either side — 1.0 was measured and did not help", () => {
  assert.equal(AUDIO_GATE_PARAMS.windowS, 0.35);
});

/* The slack guard still applies inside the 0.35s window (a span of up to 0.7s
   gives slack 2), and these pass windowS explicitly so they keep testing the
   MECHANISM rather than whatever the default happens to be that week. */
const wide = { ...AUDIO_GATE_PARAMS, windowS: 1.0 };

test("far evidence is held to a HIGHER bar than near evidence", () => {
  const gentle = (lead: number) => {
    const stats = newAudioGateStats();
    const hits = confirmAudioContacts({
      onsets: [onset(1.0)],
      ballPoints: [
        // In flat, out at ~34 deg with a 1.8x pace change: clears the base
        // thresholds (12 deg / 1.6x) but not 3x them.
        bp(1.0 - lead - 0.08, 0.48, 0.50), bp(1.0 - lead, 0.50, 0.50),
        bp(1.0 + lead, 0.53, 0.49), bp(1.0 + lead + 0.08, 0.56, 0.47),
      ],
      tracks: [trackAt("p1", 0.52, 0.48)],
      params: wide,
      stats,
    });
    return { hits, stats };
  };
  assert.equal(gentle(0.10).hits.length, 1, "close evidence: a small turn is a strike");
  const far = gentle(0.55);
  assert.equal(far.hits.length, 0, "distant evidence: the same small turn is just flight");
  assert.equal(far.stats.rejectedNoChange, 1);
});

test("a contact confirmed from far away carries lower confidence", () => {
  const run = (lead: number) => confirmAudioContacts({
    onsets: [onset(1.0)],
    ballPoints: [
      bp(1.0 - lead - 0.08, 0.30, 0.60), bp(1.0 - lead, 0.40, 0.50),
      bp(1.0 + lead, 0.40, 0.30), bp(1.0 + lead + 0.08, 0.30, 0.20),
    ],
    tracks: [trackAt("p1", 0.40, 0.40)],
    params: wide,
  })[0];
  const near = run(0.10), far = run(0.55);
  assert.ok(near && far, "both should be accepted — this is a hard reversal");
  assert.ok(far.confidence < near.confidence,
    `far ${far.confidence} should be less certain than near ${near.confidence}`);
});

/* ---- where the contact is placed -------------------------------------- */

test("the contact lands at the corner the ball turned, not on the chord", () => {
  // In heading down-right, out heading down-left, apex at (0.60, 0.50).
  // The chord between the last sighting (0.50,0.40) and the first after
  // (0.50,0.60) has its midpoint at (0.50,0.50) -- 0.1 to the left of where
  // the strike actually happened, out in open court.
  const hits = confirmAudioContacts({
    onsets: [onset(1.0)],
    ballPoints: [
      bp(0.86, 0.40, 0.30), bp(0.94, 0.50, 0.40),
      bp(1.06, 0.50, 0.60), bp(1.14, 0.40, 0.70),
    ],
    tracks: [trackAt("p1", 0.62, 0.52)],
  });
  assert.equal(hits.length, 1);
  const { x, y } = hits[0].ball;
  assert.ok(Math.abs(x - 0.60) < 0.02, `apex x ${x} should be 0.60, not the chord's 0.50`);
  assert.ok(Math.abs(y - 0.50) < 0.02, `apex y ${y} should be 0.50`);
});

test("a straight-line reversal has no apex, so it keeps the chord", () => {
  // Ball in along y=0.50 going right, out along y=0.40 going left. Those two
  // lines are PARALLEL and never meet -- there is no corner to find, however
  // obvious the reversal looks. Falling back is the correct behaviour, and
  // this is here so nobody "fixes" the guard that produces it.
  const hits = confirmAudioContacts({
    onsets: [onset(1.0)],
    ballPoints: [
      bp(0.86, 0.50, 0.50), bp(0.94, 0.60, 0.50),
      bp(1.06, 0.60, 0.40), bp(1.14, 0.50, 0.40),
    ],
    tracks: [trackAt("p1", 0.68, 0.45)],
  });
  assert.equal(hits.length, 1);
  assert.ok(Math.abs(hits[0].ball.x - 0.60) < 1e-6, "falls back to the interpolated point");
});

test("a glancing contact falls back to the chord rather than a wild apex", () => {
  // Legs nearly parallel: the lines meet far away and the intersection is
  // noise. Better an honest midpoint than a confident wrong marker.
  const hits = confirmAudioContacts({
    onsets: [onset(1.0)],
    ballPoints: [
      bp(0.86, 0.30, 0.50), bp(0.94, 0.40, 0.50),
      bp(1.06, 0.52, 0.505), bp(1.14, 0.64, 0.515),
    ],
    tracks: [trackAt("p1", 0.46, 0.50)],
    params: { ...AUDIO_GATE_PARAMS, minTurnDeg: 1, minSpeedRatio: 1.05 },
  });
  if (hits.length) {
    const { x, y } = hits[0].ball;
    assert.ok(x >= 0.38 && x <= 0.54, `fallback x ${x} should sit between the sightings`);
    assert.ok(y >= 0.45 && y <= 0.56, `fallback y ${y} should stay near the path`);
  }
});

test("the placement never leaves the frame", () => {
  const hits = confirmAudioContacts({
    onsets: [onset(1.0)],
    ballPoints: [
      bp(0.86, 0.90, 0.50), bp(0.94, 0.97, 0.50),
      bp(1.06, 0.97, 0.44), bp(1.14, 0.90, 0.44),
    ],
    tracks: [trackAt("p1", 0.95, 0.47)],
  });
  for (const h of hits) {
    assert.ok(h.ball.x >= 0 && h.ball.x <= 1, `x ${h.ball.x} out of frame`);
    assert.ok(h.ball.y >= 0 && h.ball.y <= 1, `y ${h.ball.y} out of frame`);
  }
});
