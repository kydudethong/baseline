/**
 * The court model is what both editors now draw. If it is wrong, a user
 * confirms a court that is wrong, and every measurement downstream inherits it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COURT_L, courtSegments, courtHomography, feetToPixelsAtNet,
} from "./court-model";

/** A head-on court filling a 1000x800 frame: 1 ft = 50px across, 800/44 down. */
const headOn = [
  { x: 0, y: 800 },      // nearLeft
  { x: 1000, y: 800 },   // nearRight
  { x: 1000, y: 0 },     // farRight
  { x: 0, y: 0 },        // farLeft
];

test("maps the court corners onto the marked quad", () => {
  const h = courtHomography(headOn, "full")!;
  assert.ok(h, "expected a homography");
  const segs = courtSegments(headOn, "full");
  assert.ok(segs.length > 0);
});

test("the net sits at 22ft, halfway up a full court", () => {
  const segs = courtSegments(headOn, "full");
  const netFloor = segs.find((s) => s.role === "net")!;
  // 22 of 44 ft => halfway between y=800 (near) and y=0 (far).
  assert.ok(Math.abs(netFloor.a[1] - 400) < 1, `net at ${netFloor.a[1]}, expected ~400`);
});

test("the net is drawn with real height, not as a flat line", () => {
  const segs = courtSegments(headOn, "full");
  const netSegs = segs.filter((s) => s.role === "net" || s.role === "net-post");
  assert.ok(netSegs.length >= 5, `expected floor + tape + 2 posts, got ${netSegs.length}`);
  assert.ok(segs.some((s) => s.role === "net-post"), "posts must exist");

  // The tape must sit ABOVE the floor line (smaller y in image space).
  const floorY = segs.find((s) => s.role === "net")!.a[1];
  const post = segs.find((s) => s.role === "net-post")!;
  const tapeY = Math.min(post.a[1], post.b[1]);
  assert.ok(tapeY < floorY, `tape ${tapeY} should be above floor ${floorY}`);
});

test("the centre of the net sags below the posts", () => {
  const segs = courtSegments(headOn, "full");
  const tape = segs.filter((s) => s.role === "net");
  // Post height 3.0ft vs centre 34/12 = 2.83ft, so the centre is LOWER, meaning
  // a LARGER image y. Getting this backwards would draw a net that bulges up.
  const ys = tape.flatMap((s) => [s.a[1], s.b[1]]);
  const highest = Math.min(...ys);
  const atCentre = tape.find((s) => Math.abs(s.b[0] - 500) < 1)?.b[1]
    ?? tape.find((s) => Math.abs(s.a[0] - 500) < 1)?.a[1];
  assert.ok(atCentre !== undefined, "expected a tape point at the centre");
  assert.ok(atCentre! > highest, "the centre must sag below the posts");
});

test("near-half omits the far baseline and far kitchen", () => {
  const full = courtSegments(headOn, "full");
  const half = courtSegments(headOn, "near-half");
  assert.ok(half.length < full.length, `${half.length} should be fewer than ${full.length}`);
  // In near-half the marked far pair IS the net, so the net lands on it.
  const net = half.find((s) => s.role === "net")!;
  assert.ok(Math.abs(net.a[1] - 0) < 1, `net at ${net.a[1]}, expected the far edge`);
});

test("a foot is a real distance at the net", () => {
  const h = courtHomography(headOn, "full")!;
  // 20ft across 1000px = 50px per foot.
  assert.ok(Math.abs(feetToPixelsAtNet(h) - 50) < 0.5, `${feetToPixelsAtNet(h)}`);
});

test("degenerate corners produce nothing rather than NaN geometry", () => {
  const collapsed = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
  assert.deepEqual(courtSegments(collapsed, "full"), []);
});

test("fewer than four corners is not a court", () => {
  assert.equal(courtHomography([{ x: 0, y: 0 }], "full"), null);
  assert.deepEqual(courtSegments([{ x: 0, y: 0 }], "full"), []);
});

test("every segment is finite", () => {
  for (const kind of ["full", "near-half"] as const) {
    for (const s of courtSegments(headOn, kind)) {
      assert.ok([s.a[0], s.a[1], s.b[0], s.b[1]].every(Number.isFinite),
        `${kind}/${s.role} produced a non-finite point`);
    }
  }
  assert.equal(COURT_L, 44);
});
