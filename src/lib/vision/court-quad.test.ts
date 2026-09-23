import { test } from "node:test";
import assert from "node:assert/strict";
import { courtQuadProblem, type CourtCorners } from "./court-quad";

const W = 1280, H = 720;
/** A believable court from behind the baseline: wide at the bottom, narrow at the top. */
const good: CourtCorners = {
  bottomLeft: [40, 660], bottomRight: [1190, 650], topRight: [915, 356], topLeft: [335, 358],
};

test("a court shaped like a court from behind a baseline passes", () => {
  assert.equal(courtQuadProblem(good, W, H), null);
});

test("corners dragged across each other are refused", () => {
  // THE CASE THE SIZE TEST MISSED. A bow tie has the same corners, the same
  // spread and enough area — and a homography that maps the court inside out,
  // so every distance and every zone downstream is confidently wrong.
  const bowtie: CourtCorners = { ...good, topRight: good.topLeft, topLeft: good.topRight };
  assert.match(courtQuadProblem(bowtie, W, H) ?? "", /crossed over/i);
});

test("a far edge wider than the near edge is refused", () => {
  const flared: CourtCorners = { ...good, topLeft: [0, 356], topRight: [1279, 358] };
  assert.match(courtQuadProblem(flared, W, H) ?? "", /wider than the near end/i);
});

test("far corners placed on the horizon are refused", () => {
  const pinched: CourtCorners = { ...good, topLeft: [610, 356], topRight: [650, 356] };
  assert.match(courtQuadProblem(pinched, W, H) ?? "", /almost on the same spot/i);
});

test("a court marked upside down is refused", () => {
  const flipped: CourtCorners = {
    bottomLeft: [335, 358], bottomRight: [915, 356], topRight: [1190, 650], topLeft: [40, 660],
  };
  assert.match(courtQuadProblem(flipped, W, H) ?? "", /upside down|crossed/i);
});

test("a sliver pinned to the bottom of the frame is still refused", () => {
  // The original case: a 63px band accepted at 0.777 confidence.
  const sliver: CourtCorners = {
    bottomLeft: [0, 719], bottomRight: [1280, 719], topRight: [1200, 656], topLeft: [80, 656],
  };
  assert.ok(courtQuadProblem(sliver, W, H) !== null);
});

test("nothing marked is a problem, not a pass", () => {
  assert.ok(courtQuadProblem(null, W, H) !== null);
  assert.ok(courtQuadProblem(good, 0, 0) !== null);
});
