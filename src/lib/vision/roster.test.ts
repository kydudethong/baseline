import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRoster, appearanceDistance, COURT_W_FT, COURT_L_FT } from "./roster";
import type { BoundingBoxNorm, FrameDetectionSet } from "./phase2-types";

/**
 * A fake court: the whole frame maps linearly onto 0..20 by 0..44 feet, so a
 * test can say "this player is standing at 5ft, 30ft" and mean it.
 */
const toCourtFeet = (box: BoundingBoxNorm) => ({
  x: (box.x + box.width / 2) * COURT_W_FT,
  y: (box.y + box.height) * COURT_L_FT,
});

/** A detection whose FEET land at (xFt, yFt). */
function at(xFt: number, yFt: number, extra: Partial<{ confidence: number; h: number; s: number; v: number }> = {}) {
  const w = 0.06, h = 0.12;
  return {
    boxImageNorm: { x: xFt / COURT_W_FT - w / 2, y: yFt / COURT_L_FT - h, width: w, height: h },
    confidence: extra.confidence ?? 0.9,
    appearanceSignature: extra.h !== undefined
      ? { h: extra.h, s: extra.s ?? 0.8, v: extra.v ?? 0.6 }
      : null,
  };
}

function frames(rows: Array<{ t: number; people: ReturnType<typeof at>[] }>): FrameDetectionSet[] {
  return rows.map((r) => ({
    timestampSeconds: r.t,
    framePath: `f${r.t}.jpg`,
    // A detection carries its own timestamp as well as the frame's.
    players: r.people.map((p) => ({ ...p, timestampSeconds: r.t })),
  }));
}

test("four players on court produce exactly four tracks", () => {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    const t = i * 0.2;
    rows.push({ t, people: [
      at(5 + Math.sin(i) * 0.5, 14), at(15 + Math.cos(i) * 0.5, 14),   // near pair
      at(5 + Math.cos(i) * 0.5, 30), at(15 + Math.sin(i) * 0.5, 30),   // far pair
    ]});
  }
  const got = buildRoster(frames(rows), { toCourtFeet });
  assert.equal(got.tracks.length, 4, `got ${got.tracks.length} tracks`);
  for (const tr of got.tracks) assert.equal(tr.points.length, 20, `${tr.playerId} has gaps`);
});

test("the count does not grow when the tracker would have lost somebody", () => {
  // THE SEVENTY-THREE CASE. One player vanishes for a stretch -- behind a
  // partner, out of frame -- and comes back. A track-stitching tracker mints
  // a new identity here every time; this must not.
  const rows = [];
  for (let i = 0; i < 30; i++) {
    const t = i * 0.2;
    const people = [at(5, 14), at(15, 14), at(15, 30)];
    // The far-left player disappears for frames 10-19 and returns.
    if (i < 10 || i >= 20) people.push(at(5, 30));
    rows.push({ t, people });
  }
  const got = buildRoster(frames(rows), { toCourtFeet });
  assert.equal(got.tracks.length, 4, `got ${got.tracks.length} tracks after an occlusion`);
  const rejoined = got.tracks.find((tr) => tr.points.length === 20);
  assert.ok(rejoined, "the player who left and came back did not rejoin their own slot");
});

test("people off the court are dropped", () => {
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push({ t: i * 0.2, people: [
      at(5, 14), at(15, 14), at(5, 30), at(15, 30),
      at(-14, 30),                 // a spectator well outside the sideline
      at(COURT_W_FT + 14, 10),     // someone on the next court
      at(10, COURT_L_FT + 16),     // a pair waiting behind the far fence
    ]});
  }
  const got = buildRoster(frames(rows), { toCourtFeet });
  assert.equal(got.tracks.length, 4);
  assert.ok(got.droppedOffCourt >= 36, `only ${got.droppedOffCourt} off-court detections dropped`);
  // And nobody standing off the court got into a slot.
  for (const tr of got.tracks) {
    for (const p of tr.points) {
      assert.ok(p.courtPosition!.x > -7 && p.courtPosition!.x < COURT_W_FT + 7,
        `a slot picked up somebody at x=${p.courtPosition!.x}`);
    }
  }
});

test("a near-side player is never matched to a far-side detection", () => {
  // Two players a few pixels apart ON SCREEN and twenty feet apart on the
  // court -- the exact case that swaps identities in image space. Both sit
  // near the net, one either side.
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push({ t: i * 0.2, people: [at(10, 21), at(10.2, 23), at(4, 16), at(16, 28)] });
  }
  const got = buildRoster(frames(rows), { toCourtFeet });
  for (const tr of got.tracks) {
    const sides = new Set(tr.points.map((p) => (p.courtPosition!.y < 22 ? "near" : "far")));
    assert.equal(sides.size, 1, `${tr.playerId} was tracked across the net`);
  }
});

test("two players crossing do not swap identities", () => {
  // Partners switching sides of their own half, passing close together. The
  // greedy choice at the crossing point is the wrong one; the assignment has
  // to consider the pair together.
  const rows = [];
  for (let i = 0; i < 21; i++) {
    const f = i / 20;
    const left = at(4 + f * 12, 14);
    const right = at(16 - f * 12, 14);
    // THE DETECTION ORDER IS SHUFFLED, and that is the point of the test.
    // YOLO emits bodies in whatever order they came out of the network, not
    // in the order we happen to hold our slots. With the order stable the
    // first pairing tried is always the correct one, so a greedy assignment
    // passes and the test proves nothing -- which is exactly what the first
    // version of this test did.
    const near = i % 2 === 0 ? [left, right] : [right, left];
    rows.push({ t: i * 0.2, people: [...near, at(5, 30), at(15, 30)] });
  }
  const got = buildRoster(frames(rows), { toCourtFeet });
  assert.equal(got.tracks.length, 4);
  const near = got.tracks.filter((tr) => tr.points[0].courtPosition!.y < 22);
  assert.equal(near.length, 2);
  // A SWAPPED IDENTITY IS A TELEPORT, and that is what to assert on.
  //
  // Checking only where each track starts and ends does not work: identities
  // that swap on every frame still arrive where they should, so the first
  // version of this assertion passed happily against a deliberately broken
  // assignment. A player walking across their half moves about half a foot
  // between frames; a swap moves them the whole way across.
  for (const tr of near) {
    for (let i = 1; i < tr.points.length; i++) {
      const jump = Math.abs(tr.points[i].courtPosition!.x - tr.points[i - 1].courtPosition!.x);
      assert.ok(jump < 4,
        `${tr.playerId} jumped ${jump.toFixed(1)}ft between frames — identities were swapped`);
    }
    const first = tr.points[0].courtPosition!.x;
    const last = tr.points[tr.points.length - 1].courtPosition!.x;
    assert.ok(Math.abs(last - first) > 8,
      `${tr.playerId} only moved ${Math.abs(last - first).toFixed(1)}ft — it never crossed`);
  }
});

test("singles asks for two slots, not four", () => {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push({ t: i * 0.2, people: [at(10, 14), at(10, 30)] });
  const got = buildRoster(frames(rows), { toCourtFeet, slotsPerSide: 1 });
  assert.equal(got.tracks.length, 2);
});

test("a fifth body on one side does not become a fifth player", () => {
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push({ t: i * 0.2, people: [
      at(5, 14), at(15, 14), at(10, 16, { confidence: 0.4 }), // a bystander inside the lines
      at(5, 30), at(15, 30),
    ]});
  }
  const got = buildRoster(frames(rows), { toCourtFeet });
  assert.equal(got.tracks.length, 4, `got ${got.tracks.length}`);
  assert.ok(got.droppedSurplus > 0, "the extra body was not reported as surplus");
});

test("no court means no roster, rather than a worse tracker", () => {
  const rows = [{ t: 0, people: [at(5, 14), at(15, 14)] }, { t: 0.2, people: [at(5, 14)] }];
  const got = buildRoster(frames(rows), { toCourtFeet: () => null });
  assert.deepEqual(got.tracks, [], "should refuse rather than guess without court geometry");
});

test("appearance breaks ties but hue is ignored on black kit", () => {
  const red = { h: 0, s: 0.9, v: 0.5 };
  const blue = { h: 220, s: 0.9, v: 0.5 };
  assert.ok(appearanceDistance(red, blue) > 0.5, "clearly different shirts read as different");
  const black1 = { h: 10, s: 0.03, v: 0.1 };
  const black2 = { h: 200, s: 0.03, v: 0.1 };
  assert.ok(appearanceDistance(black1, black2) < 0.1,
    "two black shirts must not read as different just because their hue noise differs");
});

test("one visible player goes to their OWN slot, not always the first", () => {
  // THE BUG THIS PINS. The assignment used to pick which CANDIDATES to use
  // but always filled slots 0..k-1, so whenever one of a pair was occluded
  // the survivor was handed slot 0 regardless of which player they were. The
  // near pair swapped identities every time either of them was briefly lost.
  const rows = [];
  for (let i = 0; i < 24; i++) {
    const people = [at(5, 30), at(15, 30)];
    // Frames 8-15: only the RIGHT-hand near player is visible.
    if (i >= 8 && i < 16) people.push(at(15, 14));
    else people.push(at(5, 14), at(15, 14));
    rows.push({ t: i * 0.2, people });
  }
  const got = buildRoster(frames(rows), { toCourtFeet });
  const near = got.tracks.filter((tr) => tr.points[0].courtPosition!.y < 22);
  assert.equal(near.length, 2);
  for (const tr of near) {
    const xs = tr.points.map((p) => p.courtPosition!.x);
    const spread = Math.max(...xs) - Math.min(...xs);
    assert.ok(spread < 3,
      `${tr.playerId} ranged over ${spread.toFixed(1)}ft — the lone visible player was put in the wrong slot`);
  }
});

test("slots keep their own player through jitter and dropout", () => {
  // THE FAILURE THIS PINS, found by simulating 1,500 frames rather than by
  // reading the code: four jittering players with 25% dropout came out as
  // slots holding 2, 1, 18 and 9 points. It looked like runaway extrapolation
  // and was not -- it was assign() only ever filling slots 0..k-1, so every
  // frame where one of a pair was missing handed the survivor the wrong slot.
  //
  // The assertion that catches it is the JUMP SIZE. Counts alone do not: with
  // the bug present the four slots still fill up, they just swap constantly,
  // which shows as a player teleporting across their half between frames.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const people: ReturnType<typeof at>[] = [];
    ([[5, 14], [15, 14], [5, 30], [15, 30]] as const).forEach(([x, y], k) => {
      if (rnd() > 0.25) people.push(at(x + Math.sin(i / 7 + k) * 3, y + Math.cos(i / 9 + k) * 2));
    });
    rows.push({ t: i * 0.2, people });
  }
  const got = buildRoster(frames(rows), { toCourtFeet });
  assert.equal(got.tracks.length, 4);
  assert.equal(got.droppedSurplus, 0, `${got.droppedSurplus} real detections were binned as surplus`);
  for (const tr of got.tracks) {
    assert.ok(tr.points.length > 220,
      `${tr.playerId} only held ${tr.points.length} of ~300 expected frames`);
    let maxJump = 0;
    for (let i = 1; i < tr.points.length; i++) {
      const a = tr.points[i - 1].courtPosition!, b = tr.points[i].courtPosition!;
      maxJump = Math.max(maxJump, Math.hypot(b.x - a.x, b.y - a.y));
    }
    assert.ok(maxJump < 6,
      `${tr.playerId} jumped ${maxJump.toFixed(1)}ft between frames — it is holding two different people`);
  }
});
