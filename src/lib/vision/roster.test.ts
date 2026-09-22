import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRoster, appearanceDistance, otsuSplit, COURT_W_FT, COURT_L_FT, MIN_SPLIT_QUALITY } from "./roster";
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
/**
 * One colour in all three bands, for the many tests that only care that two
 * players look different, not how. A real signature has three distinct bands;
 * these tests predate them and their subject is geometry.
 */
function kitAllOver(c: { h: number; s: number; v: number }) {
  return { head: c, torso: c, legs: c };
}

function at(xFt: number, yFt: number, extra: Partial<{ confidence: number; h: number; s: number; v: number }> = {}) {
  const w = 0.06, h = 0.12;
  return {
    boxImageNorm: { x: xFt / COURT_W_FT - w / 2, y: yFt / COURT_L_FT - h, width: w, height: h },
    confidence: extra.confidence ?? 0.9,
    appearanceSignature: extra.h !== undefined
      ? kitAllOver({ h: extra.h, s: extra.s ?? 0.8, v: extra.v ?? 0.6 })
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

/* ---------------------------------------------------------------------- *
 * NO COURT AT ALL.
 *
 * These are the regression tests for the bug that made the whole module
 * pointless in production. buildRoster used to return an empty list when the
 * homography could not place the detections, and the caller fell back to the
 * tracker. Court detection was then removed from the product, so that branch
 * fired on EVERY run: the roster shipped, deployed, and the tag page still
 * offered seventy-four chips. The unit tests all passed, because every one of
 * them supplied a court.
 *
 * So: the same scenarios, with toCourtFeet returning null exactly as it does
 * in production now.
 * ---------------------------------------------------------------------- */

/** A reproducible pseudo-random source, so a failure is the same failure twice. */
function lcg(seed: number): () => number {
  let x = seed;
  return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
}

const noCourt = () => null;

/** Foot position in the image, which is what the image plane tracks. */
const footOf = (p: { boxImageNorm: BoundingBoxNorm }) => ({
  x: p.boxImageNorm.x + p.boxImageNorm.width / 2,
  y: p.boxImageNorm.y + p.boxImageNorm.height,
});

test("no court still produces exactly four players", () => {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    const t = i * 0.2;
    rows.push({ t, people: [
      at(5 + Math.sin(i) * 0.5, 14), at(15 + Math.cos(i) * 0.5, 14),
      at(5 + Math.cos(i) * 0.5, 30), at(15 + Math.sin(i) * 0.5, 30),
    ]});
  }
  const got = buildRoster(frames(rows), { toCourtFeet: noCourt });
  assert.equal(got.plane, "image");
  assert.equal(got.tracks.length, 4, `got ${got.tracks.length} tracks without a court`);
  for (const tr of got.tracks) assert.equal(tr.points.length, 20, `${tr.playerId} has gaps`);
});

test("no court, and an occlusion still does not mint a fifth identity", () => {
  // THE SEVENTY-FOUR CASE, in the configuration production actually runs.
  const rows = [];
  for (let i = 0; i < 30; i++) {
    const people = [at(5, 14), at(15, 14), at(15, 30)];
    if (i < 10 || i >= 20) people.push(at(5, 30));
    rows.push({ t: i * 0.2, people });
  }
  const got = buildRoster(frames(rows), { toCourtFeet: noCourt });
  assert.equal(got.tracks.length, 4, `got ${got.tracks.length} tracks after an occlusion`);
  const rejoined = got.tracks.find((tr) => tr.points.length === 20);
  assert.ok(rejoined, "the player who left and came back did not rejoin their own slot");
});

test("no court, and the dividing line is still not crossed", () => {
  // FOUR STATIC POINTS WOULD PROVE NOTHING, and the first version of this test
  // used them: players parked at (4,12) (16,12) (4,32) (16,32) are exactly as
  // bimodal across the image as they are down it, so which axis wins is a
  // coin toss and the assertion was testing the rounding in Otsu's histogram.
  // It duly failed, which is how the binning bug in otsuSplit was found.
  //
  // Real footage does not look like that. Players ROAM their half from
  // sideline to sideline, so from behind a baseline the x positions smear into
  // one broad band while y stays in two tight ones -- and that asymmetry, not
  // a tie, is what tells the two halves apart.
  const rnd = lcg(7);
  const rows = [];
  for (let i = 0; i < 60; i++) {
    // Continuous positions, not twenty evenly-spaced ones. Discrete sweeps
    // leave empty bins between the values they land on, and an empty bin reads
    // as a valley -- the second version of this test "passed" the x axis at
    // quality 1.0 on a distribution that was uniform by construction.
    rows.push({ t: i * 0.2, people: [
      at(3 + rnd() * 14, 11 + rnd() * 4), at(3 + rnd() * 14, 11 + rnd() * 4),
      at(3 + rnd() * 14, 29 + rnd() * 4), at(3 + rnd() * 14, 29 + rnd() * 4),
    ]});
  }
  const got = buildRoster(frames(rows), { toCourtFeet: noCourt });
  assert.ok(got.split, "no dividing line was found in obviously two-sided footage");
  assert.equal(got.split!.axis, "y", `split on ${got.split!.axis}, but this camera is behind a baseline`);
  for (const tr of got.tracks) {
    const sides = new Set(tr.points.map((p) => (footOf(p).y < got.split!.at ? "a" : "b")));
    assert.equal(sides.size, 1, `${tr.playerId} was tracked across the dividing line`);
  }
});

test("no court, and two crossing players still do not swap", () => {
  const rows = [];
  for (let i = 0; i < 21; i++) {
    const f = i / 20;
    const left = at(4 + f * 12, 14);
    const right = at(16 - f * 12, 14);
    // Shuffled, for the same reason as the court version: with a stable order
    // the first pairing tried is the right one and a greedy assignment passes.
    const near = i % 2 === 0 ? [left, right] : [right, left];
    rows.push({ t: i * 0.2, people: [...near, at(5, 30), at(15, 30)] });
  }
  const got = buildRoster(frames(rows), { toCourtFeet: noCourt });
  assert.equal(got.tracks.length, 4);
  const crossing = got.tracks.filter((tr) => Math.abs(
    footOf(tr.points[tr.points.length - 1]).x - footOf(tr.points[0]).x
  ) > 0.2);
  assert.equal(crossing.length, 2, "the two players who crossed did not both arrive on the far side");
  for (const tr of crossing) {
    for (let i = 1; i < tr.points.length; i++) {
      const jump = Math.abs(footOf(tr.points[i]).x - footOf(tr.points[i - 1]).x);
      assert.ok(jump < 0.15,
        `${tr.playerId} jumped ${jump.toFixed(3)} of a frame width between frames — identities swapped`);
    }
  }
});

test("a camera at the side splits on x, not on y", () => {
  // The same four players, filmed from the sideline: the net now runs up the
  // image rather than across it. Nothing may assume which axis it is.
  const sideOn = (xFt: number, yFt: number) => at(yFt * (COURT_W_FT / COURT_L_FT), xFt * (COURT_L_FT / COURT_W_FT));
  const rnd = lcg(11);
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push({ t: i * 0.2, people: [
      sideOn(3 + rnd() * 14, 11 + rnd() * 4), sideOn(3 + rnd() * 14, 11 + rnd() * 4),
      sideOn(3 + rnd() * 14, 29 + rnd() * 4), sideOn(3 + rnd() * 14, 29 + rnd() * 4),
    ]});
  }
  const got = buildRoster(frames(rows), { toCourtFeet: noCourt });
  assert.ok(got.split, "no dividing line found in side-on footage");
  assert.equal(got.split!.axis, "x", "a side-on camera separates the halves across the image, not down it");
  assert.equal(got.tracks.length, 4);
});

test("when the two sides cannot be told apart, four slots — never five", () => {
  // A camera down at court level, where the far players are hidden behind the
  // near ones: everybody occupies the same band of the image and their paths
  // overlap on BOTH axes, so neither histogram has a valley in it. Four static
  // points would not do -- four distinct x values are perfectly bimodal and
  // Otsu would rightly find a line between them. The failure this guards is
  // inventing a net where the footage genuinely has no separation.
  const rnd = lcg(3);
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push({ t: i * 0.2, people: [0, 1, 2, 3].map(() => at(3 + rnd() * 14, 18 + rnd() * 8)) });
  }
  const got = buildRoster(frames(rows), { toCourtFeet: noCourt });
  assert.equal(got.split, null, "a line was invented where the histogram has no valley");
  assert.ok(got.tracks.length <= 4, `got ${got.tracks.length} tracks from one undivided pool`);
  assert.ok(got.tracks.length >= 1, "the undivided pool produced nothing at all");
});

test("otsu finds the valley between two groups, and reports a smear as one", () => {
  const twoGroups = [...Array(30)].map((_, i) => 0.2 + (i % 5) * 0.01)
    .concat([...Array(30)].map((_, i) => 0.8 + (i % 5) * 0.01));
  const split = otsuSplit(twoGroups);
  assert.ok(split, "no split found in two obviously separated groups");
  assert.ok(split!.at > 0.24 && split!.at <= 0.8, `threshold ${split!.at} is not between the groups`);
  assert.ok(split!.quality > MIN_SPLIT_QUALITY, `quality ${split!.quality} too low for two clear groups`);

  // THE CASE THE FIRST SCORING MISSED ENTIRELY. Otsu's between-class variance
  // ratio is 0.75 for a uniform spread, not 0 -- so the original floor of 0.35
  // accepted a net line in footage that has no sides in it at all, and the
  // fallback branch could never run. This assertion is the one that failed.
  const smear = [...Array(240)].map((_, i) => i / 240);
  const flat = otsuSplit(smear);
  assert.ok(flat === null || flat.quality < MIN_SPLIT_QUALITY,
    `a uniform spread reported quality ${flat?.quality} — it would invent a net line`);

  // And a hump with a shallow dent in it is still one hump.
  const dented = [...Array(200)].map((_, i) => {
    const x = i / 200;
    return 0.5 + Math.sin(x * Math.PI * 2) * 0.05 + x * 0.3;
  });
  const d = otsuSplit(dented);
  assert.ok(d === null || d.quality < MIN_SPLIT_QUALITY,
    `a single dented hump reported quality ${d?.quality}`);
});

test("distances scale with the player, so the far court is judged as fairly as the near", () => {
  // Two players at the SAME image position-ish but very different sizes: one
  // close to the camera, one far away. The far player's box is a third the
  // height, so their strides cover a third the pixels. Measured in pixels the
  // far player looks stationary and the near one looks frantic; measured in
  // body heights they are doing the same thing, which is the only reading that
  // lets one jump limit govern both halves of the court.
  const person = (x: number, y: number, h: number) => ({
    boxImageNorm: { x, y: y - h, width: h * 0.45, height: h },
    confidence: 0.9,
    appearanceSignature: null,
  });
  const rows = [];
  for (let i = 0; i < 16; i++) {
    const near = person(0.2 + i * 0.02, 0.9, 0.3);   // big box, big strides
    const far = person(0.45 + i * 0.0067, 0.35, 0.1); // small box, small strides
    rows.push({ t: i * 0.2, people: [near, far, person(0.7, 0.88, 0.3), person(0.6, 0.34, 0.1)] });
  }
  const got = buildRoster(frames(rows), { toCourtFeet: noCourt });
  assert.equal(got.tracks.length, 4);
  for (const tr of got.tracks) {
    assert.equal(tr.points.length, 16, `${tr.playerId} lost frames — a size difference broke the match`);
  }
});

test("a near player's stride is not judged by a far player's ruler", () => {
  // WHAT THE BODY-HEIGHT UNIT IS FOR, stated as a thing that breaks without
  // it. A player close to the camera fills a third of the frame and covers a
  // tenth of its width in a lunge; a player at the far baseline fills a
  // twelfth and covers a fiftieth doing the same thing. One jump limit has to
  // govern both, so distances are measured in the player's OWN box heights.
  // Hardcode the ruler to the far player's size and the near player's ordinary
  // lunge becomes a teleport, and their slot drops them mid-rally.
  const person = (x: number, y: number, h: number) => ({
    boxImageNorm: { x, y: y - h, width: h * 0.4, height: h },
    confidence: 0.9,
    appearanceSignature: null,
  });
  const rows = [];
  for (let i = 0; i < 16; i++) {
    const lunge = (i % 2) * 0.1;                  // 10% of frame width, every other frame
    rows.push({ t: i * 0.2, people: [
      person(0.15 + lunge, 0.95, 0.4), person(0.6 + lunge, 0.95, 0.4),  // near, big boxes
      person(0.3, 0.32, 0.08), person(0.55, 0.32, 0.08),                // far, small boxes
    ]});
  }
  const got = buildRoster(frames(rows), { toCourtFeet: noCourt });
  assert.equal(got.tracks.length, 4);
  for (const tr of got.tracks) {
    assert.equal(tr.points.length, 16,
      `${tr.playerId} kept only ${tr.points.length} of 16 frames — a stride was measured against the wrong ruler`);
  }
});

test("geometry outranks a shirt colour, at the scale the bodies actually are", () => {
  // Appearance is added to the cost unscaled while distance is divided by the
  // body height, so the ruler sets the BALANCE between them as well as the
  // reach. Too large a ruler shrinks every distance toward zero and colour
  // starts deciding who is who -- which is the one thing the comment in
  // cost1() promises it will never do.
  //
  // Two players a body apart at the net, in clearly different kit. On one
  // frame the appearance readings swap (a turn, a shadow, a flare off a white
  // shirt). Geometry must hold them in place.
  const kit = (h: number) => kitAllOver({ h, s: 0.9, v: 0.6 });
  const person = (x: number, look: ReturnType<typeof kitAllOver>) => ({
    boxImageNorm: { x, y: 0.75, width: 0.06, height: 0.15 },
    confidence: 0.9,
    appearanceSignature: look,
  });
  // 0.15 apart in raw x is about one body height once the frame's aspect is
  // applied -- close enough that a mis-scaled cost flips the pairing.
  const rows = [];
  for (let i = 0; i < 14; i++) {
    const flicker = i === 7;
    rows.push({ t: i * 0.2, people: [
      person(0.40, kit(flicker ? 220 : 0)), person(0.55, kit(flicker ? 0 : 220)),
      person(0.30, kit(90)), person(0.60, kit(300)),
    ].map((p, k) => ({ ...p, boxImageNorm: { ...p.boxImageNorm, y: k < 2 ? 0.75 : 0.25 } })) });
  }
  const got = buildRoster(frames(rows), { toCourtFeet: noCourt });
  const lower = got.tracks.filter((tr) => tr.points[0].boxImageNorm.y > 0.5);
  assert.equal(lower.length, 2);
  for (const tr of lower) {
    const xs = tr.points.map((p) => p.boxImageNorm.x);
    assert.equal(new Set(xs).size, 1,
      `${tr.playerId} moved between x=${[...new Set(xs)].join(" and ")} — a colour flicker swapped two stationary players`);
  }
});

test("a sideways jump too far to be real is refused, in the frame's own proportions", () => {
  // A 16:9 frame is nearly twice as wide as it is tall, so a tenth of the
  // WIDTH is a much bigger step than a tenth of the HEIGHT. Without correcting
  // for that, horizontal movement costs 1.78x too little and a slot reaches
  // across the court for somebody who is not its player. Here the lone
  // detection is four feet from the left-hand slot: three body heights once
  // the aspect is applied, which is past the limit, and a comfortable 1.7
  // without it, which is not.
  const rows = [];
  for (let i = 0; i < 8; i++) {
    rows.push({ t: i * 0.2, people: [at(3, 14), at(17, 14), at(5, 30), at(15, 30)] });
  }
  // Then only one body on the near side, four feet from where the left slot
  // last saw its player and nowhere near the right one.
  rows.push({ t: 1.6, people: [at(7, 14), at(5, 30), at(15, 30)] });
  const got = buildRoster(frames(rows), { toCourtFeet: noCourt });
  const leftSlot = got.tracks.find((tr) => Math.abs(tr.points[0].boxImageNorm.x - (3 / COURT_W_FT - 0.03)) < 1e-9);
  assert.ok(leftSlot, "the left-hand near slot was never seeded");
  assert.equal(leftSlot!.points.length, 8,
    "the left slot followed a body four feet away — the jump limit is being measured in the wrong proportions");
  assert.ok(got.droppedSurplus > 0, "the unmatched body was not reported as surplus");
});

test("an image-plane track carries no court position", () => {
  // Body heights on a screen are not a place on a court. Handing them to
  // anything that measures in feet would be a fabrication with units on it.
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push({ t: i * 0.2, people: [at(5, 14), at(15, 14), at(5, 30), at(15, 30)] });
  const got = buildRoster(frames(rows), { toCourtFeet: noCourt });
  for (const tr of got.tracks) {
    for (const p of tr.points) assert.equal(p.courtPosition, null);
  }
});

test("appearance breaks ties but hue is ignored on black kit", () => {
  const red = kitAllOver({ h: 0, s: 0.9, v: 0.5 });
  const blue = kitAllOver({ h: 220, s: 0.9, v: 0.5 });
  assert.ok(appearanceDistance(red, blue) > 0.5, "clearly different shirts read as different");
  const black1 = kitAllOver({ h: 10, s: 0.03, v: 0.1 });
  const black2 = kitAllOver({ h: 200, s: 0.03, v: 0.1 });
  assert.ok(appearanceDistance(black1, black2) < 0.1,
    "two black shirts must not read as different just because their hue noise differs");
});

test("two players in the SAME shirt are still told apart by hair and shoes", () => {
  // THE CASE THAT USED TO BE INVISIBLE. The signature was one mean over the
  // torso, so matching kit did not weaken it, it zeroed it -- and geometry was
  // left alone with two people standing close together on the same side of the
  // net, which is the one arrangement geometry is worst at.
  const shirt = { h: 210, s: 0.8, v: 0.6 };
  const a = { head: { h: 30, s: 0.5, v: 0.25 }, torso: shirt, legs: { h: 0, s: 0.02, v: 0.92 } };
  const b = { head: { h: 45, s: 0.6, v: 0.75 }, torso: shirt, legs: { h: 0, s: 0.02, v: 0.08 } };
  assert.ok(appearanceDistance(a, b) > 0.25,
    `identical shirts, dark vs light hair, white vs black shoes read as ${appearanceDistance(a, b).toFixed(3)} apart`);
  // And the same person at two instants still reads as the same person.
  assert.ok(appearanceDistance(a, { ...a, torso: { ...shirt, v: 0.55 } }) < 0.05);
});

test("a band nobody can see is skipped, not counted as agreement", () => {
  // A player whose legs are behind the net has no leg band. Dividing by a
  // fixed total would let that missing term read as a perfect match on the
  // legs -- making the half-hidden player a closer match to EVERYBODY, worst
  // at the far end of the court where the net cuts bodies off.
  const seen = { head: { h: 30, s: 0.5, v: 0.3 }, torso: { h: 210, s: 0.8, v: 0.6 }, legs: { h: 0, s: 0.02, v: 0.9 } };
  const hidden = { head: { h: 200, s: 0.5, v: 0.3 }, torso: { h: 20, s: 0.8, v: 0.6 }, legs: null };
  const bothVisible = { ...hidden, legs: { h: 0, s: 0.02, v: 0.9 } };
  // STRICTLY GREATER. These two have identical legs, so the visible pairing
  // averages in a zero while the hidden one renormalises over what is left --
  // and a fixed divisor makes them exactly equal, which `>=` waves through.
  const hiddenD = appearanceDistance(seen, hidden);
  const visibleD = appearanceDistance(seen, bothVisible);
  assert.ok(hiddenD > visibleD,
    `hiding a band scored ${hiddenD.toFixed(3)} against ${visibleD.toFixed(3)} — `
    + "the missing band is being counted as agreement");
});

test("nothing in common is uncertainty, not a perfect match", () => {
  // Returning 0 for a pair with no comparable band would rank it above every
  // real match in the assignment — the cheapest pairing available.
  const none = { head: null, torso: null, legs: null };
  const d = appearanceDistance(none, { head: { h: 10, s: 0.9, v: 0.5 }, torso: null, legs: null });
  assert.ok(d > 0.2 && d < 0.8, `no shared band scored ${d}, which ranks it as a match`);
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

/** Two builds far enough apart to be different people, and the pair of them. */
const STOCKY = { shoulderToTorso: 1.15, legToTorso: 1.30, headToTorso: 0.32 };
const LANKY = { shoulderToTorso: 0.70, legToTorso: 2.20, headToTorso: 0.32 };

/** Everyone in the same kit, which is the case this exists for. */
const TEAM_KIT = {
  head: { h: 30, s: 0.4, v: 0.3 },
  torso: { h: 210, s: 0.85, v: 0.6 },
  legs: { h: 0, s: 0.05, v: 0.85 },
};

function twin(x: number, y: number, build: typeof STOCKY) {
  return {
    boxImageNorm: { x: x - 0.03, y: y - 0.12, width: 0.06, height: 0.12 },
    confidence: 0.9,
    appearanceSignature: TEAM_KIT,
    buildSignature: build,
  };
}

test("in identical kit, build decides a tie geometry cannot", () => {
  // THE CASE EVERYTHING ELSE FAILS. Same shirts, same shorts, same shoes — so
  // all three colour bands agree and the appearance term is exactly zero. Two
  // detections then arrive almost exactly between the two slots, which is the
  // moment geometry has nothing to say either. Build is the only thing left,
  // and it is the only cue in the system that clothing cannot change.
  const rows = [];
  for (let i = 0; i < 14; i++) {
    rows.push({ t: i * 0.2, people: [
      twin(0.40, 0.92, STOCKY), twin(0.60, 0.92, LANKY),
      twin(0.35, 0.30, STOCKY), twin(0.65, 0.30, LANKY),
    ]});
  }
  // A frame where the two near players are all but on top of each other, and
  // the stocky one is now very slightly to the RIGHT of the lanky one.
  rows.push({ t: 2.8, people: [
    twin(0.499, 0.92, LANKY), twin(0.501, 0.92, STOCKY),
    twin(0.35, 0.30, STOCKY), twin(0.65, 0.30, LANKY),
  ]});
  const got = buildRoster(frames(rows), { toCourtFeet: noCourt });
  const near = got.tracks.filter((tr) => tr.points[0].boxImageNorm.y > 0.5);
  assert.equal(near.length, 2);
  // The slot that has been following the stocky player must take the stocky
  // detection, even though the lanky one is a hair closer to where it was.
  const stockySlot = near.find((tr) => tr.points[0].boxImageNorm.x < 0.4)!;
  const lastX = stockySlot.points[stockySlot.points.length - 1].boxImageNorm.x + 0.03;
  assert.ok(lastX > 0.5,
    `the slot tracking the stocky player took the detection at ${lastX.toFixed(3)} — `
    + "it followed position over build in a frame where position said nothing"
  );
});

test("build breaks ties without overruling where somebody actually is", () => {
  // The guard on the test above. Build is measured off a 2D projection of a
  // person who bends and turns, so a single frame's reading is noisy — it is
  // weighted to settle a coin-flip, never to move a player across the court.
  // If it can do that, a bad pose frame can teleport an identity.
  //
  // CLOSE ENOUGH THAT A SWAP IS PHYSICALLY POSSIBLE, which is the whole
  // difficulty. The first version of this test put them at opposite ends of
  // the court, where a swap is refused by the jump limit before any cost is
  // compared — so it passed with the build weight cranked a hundredfold and
  // proved nothing. At two body widths apart the swap is available, and only
  // the weighting stops it.
  const rows = [];
  for (let i = 0; i < 14; i++) {
    rows.push({ t: i * 0.2, people: [
      twin(0.45, 0.92, STOCKY), twin(0.60, 0.92, LANKY),
      twin(0.35, 0.30, STOCKY), twin(0.65, 0.30, LANKY),
    ]});
  }
  // Both stay put, but their BUILD readings swap — which is what a bad pose
  // frame looks like. Position is unambiguous, so nothing should move.
  rows.push({ t: 2.8, people: [
    twin(0.45, 0.92, LANKY), twin(0.60, 0.92, STOCKY),
    twin(0.35, 0.30, STOCKY), twin(0.65, 0.30, LANKY),
  ]});
  const got = buildRoster(frames(rows), { toCourtFeet: noCourt });
  const near = got.tracks.filter((tr) => tr.points[0].boxImageNorm.y > 0.5);
  for (const tr of near) {
    const xs = tr.points.map((p) => p.boxImageNorm.x);
    assert.equal(new Set(xs).size, 1,
      "a single frame of swapped build readings moved a stationary player across the court");
  }
});

test("bystanders beside the court do not claim the slots", () => {
  // REPORTED FROM REAL FOOTAGE: two of the four tagged players were off the
  // court, and not the two who were playing.
  //
  // The clip opens with two people standing beside the near sideline — waiting
  // for the next game, which is what a public court looks like — and the real
  // players walk on a second later. Seeding took the first frame with anybody
  // in it and the MOST CONFIDENT detections in it, and a bystander near the
  // camera is large, sharp and far more confident than a player at the far
  // baseline. They then held the slot for the whole clip, because a seeded
  // slot only ever goes to whoever is nearest it.
  const rows = [];
  // Well outside the sideline: x = -4ft and x = 24ft on a 20ft court.
  for (let i = 0; i < 4; i++) {
    rows.push({ t: i * 0.2, people: [at(-4, 8), at(24, 8)] });
  }
  // Then the actual game, four people inside the lines.
  for (let i = 4; i < 24; i++) {
    rows.push({ t: i * 0.2, people: [
      at(-4, 8), at(24, 8),                    // the bystanders are still there
      at(6, 8), at(14, 8), at(6, 36), at(14, 36),
    ]});
  }
  const got = buildRoster(frames(rows), { toCourtFeet });
  assert.equal(got.tracks.length, 4);
  // Every tracked player must have spent their time inside the lines.
  for (const tr of got.tracks) {
    const xs = tr.points.map((p) => (p.courtPosition?.x ?? 0));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    assert.ok(mean > 0 && mean < 20,
      `a track sat at x=${mean.toFixed(1)}ft, outside a 20ft court — a bystander took a slot`);
  }
});

test("a clip that never shows a full court still produces a roster", () => {
  // THE FALLBACK, and it has to exist. A drill at one end, or a court marked
  // badly enough that nobody reads as inside the lines, must still return
  // tracks — some roster beats none, and refusing to seed would return an
  // empty list, which is the failure this whole file was written to end.
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push({ t: i * 0.2, people: [at(-5, 8), at(25, 8), at(-5, 36), at(25, 36)] });
  }
  const got = buildRoster(frames(rows), { toCourtFeet });
  assert.ok(got.tracks.length > 0, "seeding waited for a moment that never came");
});

test("waiting to seed does not lose players who start off court mid-rally", () => {
  // The guard on the guard. Once seeded, the loose six-foot margin still
  // applies — a player chasing a lob behind the baseline must keep their slot,
  // which is the reason that margin is generous in the first place.
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push({ t: i * 0.2, people: [at(6, 8), at(14, 8), at(6, 36), at(14, 36)] });
  }
  // One player chases a lob to three feet behind the baseline, at a run --
  // about 2ft a frame, which is ~11 ft/s. (This once teleported 11ft in a
  // single 0.2s frame, which no player does and which is exactly how a slot
  // lands on a bystander.)
  for (let i = 10; i < 20; i++) {
    rows.push({ t: i * 0.2, people: [at(6, Math.max(-3, 8 - (i - 9) * 2.2)), at(14, 8), at(6, 36), at(14, 36)] });
  }
  const got = buildRoster(frames(rows), { toCourtFeet });
  assert.equal(got.tracks.length, 4);
  for (const tr of got.tracks) {
    assert.equal(tr.points.length, 20, `${tr.playerId} was dropped when they stepped out`);
  }
});

test("a slot whose player is hidden does not jump onto somebody beside the court", () => {
  // Reported from real footage: the read ringed a man drinking water by the
  // fence. The near-right player drops out of detection for a few frames; a
  // bystander stands 4ft off the right sideline (inside the 6ft margin), 8ft
  // from where that player was last seen. The slot must wait, not jump.
  const rows = [];
  for (let i = 0; i < 30; i++) {
    const t = i * 0.2;
    const hidden = i >= 10 && i < 16;
    rows.push({ t, people: [
      at(5, 14), ...(hidden ? [] : [at(15, 14)]),
      at(5, 30), at(15, 30),
      ...(i >= 5 ? [at(24, 12)] : []),               // the bystander, off court
    ]});
  }
  const got = buildRoster(frames(rows), { toCourtFeet });
  for (const tr of got.tracks) {
    const offCourt = tr.points.filter((p) => (p.courtPosition?.x ?? 0) > COURT_W_FT + 1.5);
    assert.equal(offCourt.length, 0, `${tr.playerId} took the bystander ${offCourt.length} time(s)`);
  }
});

test("a player who walks off the court is still followed there", () => {
  // The other side of the rule: stepping out wide for a ball, a step at a
  // time, keeps the slot.
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push({ t: i * 0.2, people: [
      at(5, 14), at(Math.min(15 + i * 0.6, 24), 14), at(5, 30), at(15, 30),
    ]});
  }
  const got = buildRoster(frames(rows), { toCourtFeet });
  const wide = got.tracks.find((tr) => tr.points.some((p) => (p.courtPosition?.x ?? 0) > 22));
  assert.ok(wide, "the player who walked wide lost their slot");
});
