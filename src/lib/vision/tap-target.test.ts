import test from "node:test";
import assert from "node:assert/strict";
import { nearestPlayerFeet, samePoint, TAP_SNAP_HEIGHTS, type TapCandidate } from "./tap-target";

/** A player 200px tall standing with their feet at (cx, footY). */
const player = (cx: number, footY: number, h = 200): TapCandidate => ({
  boxPx: [cx - h * 0.2, footY - h, h * 0.4, h],
  feetPx: [cx, footY],
});

test("a tap on the body returns the FEET, not the tap", () => {
  // The seed has to land on the court plane. matchTracksToSetup compares feet
  // with about a body height of tolerance, and a torso is most of a body
  // height off the ground — keeping the raw tap would sit right at the edge
  // of matching and work or not depending on how tall somebody was in frame.
  const feet = nearestPlayerFeet({ x: 500, y: 830 }, [player(500, 900)]);
  assert.deepEqual(feet, { x: 500, y: 900 });
});

test("a tap nowhere near anybody matches nobody, so the raw tap can be used", () => {
  assert.equal(nearestPlayerFeet({ x: 100, y: 200 }, [player(900, 900)]), null);
});

test("an empty court matches nobody rather than throwing", () => {
  // The case that makes 'you must tag yourself' satisfiable: no detections,
  // so the tap itself becomes the seed.
  assert.equal(nearestPlayerFeet({ x: 100, y: 200 }, []), null);
});

test("the nearest player wins, not the first in the list", () => {
  // Two players both within reach of one tap is the normal doubles case at the
  // net. Taking the first would hand the tap to whichever the detector
  // happened to emit first — which is how you tag an opponent while aiming at
  // your partner.
  const left = player(500, 900);   // box spans x 460..540
  const right = player(700, 900);  // box spans x 660..740
  const tap = { x: 580, y: 850 };  // 40 px from left, 80 px from right
  assert.deepEqual(nearestPlayerFeet(tap, [right, left]), { x: 500, y: 900 });
  assert.deepEqual(nearestPlayerFeet(tap, [left, right]), { x: 500, y: 900 },
    "and the answer does not depend on the order they arrived in");
});

test("a tap inside two overlapping boxes goes to the first, and that is accepted", () => {
  // Both distances are zero, so there is no nearest. Pinned rather than left
  // undefined: somebody standing directly in front of their partner is a real
  // frame, and the honest answer is that this tap cannot tell them apart —
  // which is why the user can tap again to move the mark.
  const a = player(500, 900);
  const b = player(520, 900);
  assert.deepEqual(nearestPlayerFeet({ x: 510, y: 800 }, [a, b]), { x: 500, y: 900 });
  assert.deepEqual(nearestPlayerFeet({ x: 510, y: 800 }, [b, a]), { x: 520, y: 900 });
});

test("tolerance scales with the player's size, so the far baseline is reachable", () => {
  // A player at the far baseline is a fraction of the height of one near the
  // camera. A fixed pixel radius is generous up close and unusable at range,
  // which is backwards: the far player is the harder one to hit.
  const big = player(500, 900, 400);
  const small = player(500, 900, 40);
  // 60 px outside the box edge.
  const tap = { x: 500 - 400 * 0.2 - 60, y: 800 };
  assert.ok(nearestPlayerFeet(tap, [big]), "generous on a large player");
  assert.equal(nearestPlayerFeet({ x: 500 - 40 * 0.2 - 60, y: 890 }, [small]), null,
    "and proportionally strict on a small one");
});

test("the boundary is the box edge plus the tolerance, both sides of it", () => {
  const p = player(500, 900, 200); // box x from 460 to 540
  const margin = 200 * TAP_SNAP_HEIGHTS;
  const inside = nearestPlayerFeet({ x: 460 - margin + 1, y: 800 }, [p]);
  const outside = nearestPlayerFeet({ x: 460 - margin - 1, y: 800 }, [p]);
  assert.ok(inside, "just inside the margin should snap");
  assert.equal(outside, null, "just outside it should not");
});

test("a tap inside the box always counts, however tall the player is", () => {
  // distanceToBox is 0 inside, so this holds even at tolerance 0 — worth
  // pinning, because a tap on somebody is the least ambiguous input there is.
  const p = player(500, 900, 30);
  assert.deepEqual(nearestPlayerFeet({ x: 500, y: 885 }, [p], 0), { x: 500, y: 900 });
});

test("samePoint stops one person being tagged as both you and your partner", () => {
  assert.equal(samePoint({ x: 10, y: 10 }, { x: 10.5, y: 10 }), true);
  assert.equal(samePoint({ x: 10, y: 10 }, { x: 40, y: 10 }), false);
  assert.equal(samePoint(null, { x: 10, y: 10 }), false);
  assert.equal(samePoint({ x: 10, y: 10 }, null), false);
});
