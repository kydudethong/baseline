import test from "node:test";
import assert from "node:assert/strict";
import { partnershipFrom } from "./partnership-read";

const full = {
  partnership: {
    compatibility: 6.5,
    summary: "You cover the middle; they hold the line.",
    dimensions: [
      { key: "spacing", rating: 7, basis: "nine feet apart" },
      { key: "middle_balls", rating: 4, basis: "both left it at 12.4s" },
    ],
    works_well: [{ pattern: "Reset together", why_it_works: "w", evidence: "e", at_s: 9 }],
    friction: [{ pattern: "Middle left", cost: "c", fix: "f", evidence: "e", at_s: 12.4 }],
    role_split: { you: "middle", partner: "line", imbalance: null },
    fix_together: { change: "Call it", how_to_practise: "h", at_s: 12.4 },
  },
};

test("a complete partnership read comes back intact", () => {
  const p = partnershipFrom(JSON.stringify(full));
  assert.equal(p?.compatibility, 6.5);
  assert.equal(p?.dimensions.length, 2);
  assert.equal(p?.friction[0].at_s, 12.4);
});

test("a read from before this feature existed is simply absent", () => {
  // Every coaching_json written until now. Not a corrupt row.
  assert.equal(partnershipFrom(JSON.stringify({ strengths: [], playstyle: {} })), null);
  assert.equal(partnershipFrom(null), null);
});

test("malformed JSON does not take the analysis page down", () => {
  assert.equal(partnershipFrom("{not json"), null);
});

test("a section with no compatibility or summary is dropped, not half-rendered", () => {
  // The panel leads with both. A heading over an empty box is worse than no
  // heading — it reads as the feature being broken.
  assert.equal(partnershipFrom(JSON.stringify({ partnership: { summary: "x" } })), null);
  assert.equal(partnershipFrom(JSON.stringify({ partnership: { compatibility: 5 } })), null);
  assert.equal(
    partnershipFrom(JSON.stringify({ partnership: { compatibility: 5, summary: "   " } })),
    null
  );
});

test("a dimension key the UI has no label for is dropped rather than drawn blank", () => {
  // It would render as an unnamed row with a bar beside it. We do not know
  // what was rated, so saying nothing is the honest answer.
  const out = structuredClone(full);
  out.partnership.dimensions.push({ key: "vibes", rating: 9, basis: "b" });
  const p = partnershipFrom(JSON.stringify(out));
  assert.deepEqual(p?.dimensions.map((d) => d.key), ["spacing", "middle_balls"]);
});

test("ratings off the scale are clamped, not thrown away", () => {
  // A bar at 130% overflows its track; losing the section over a model slip
  // helps nobody.
  const out = structuredClone(full);
  out.partnership.compatibility = 13;
  out.partnership.dimensions[0].rating = -4;
  const p = partnershipFrom(JSON.stringify(out));
  assert.equal(p?.compatibility, 10);
  assert.equal(p?.dimensions[0].rating, 0);
});

test("a missing timestamp reads as null rather than NaN", () => {
  // stamp() would render "NaN:NaN" on the page.
  const out = JSON.parse(JSON.stringify(full));
  delete out.partnership.friction[0].at_s;
  out.partnership.works_well[0].at_s = "12.4";
  const p = partnershipFrom(JSON.stringify(out));
  assert.equal(p?.friction[0].at_s, null);
  assert.equal(p?.works_well[0].at_s, null, "a string timestamp is not a timestamp");
});

test("missing prose fields become empty strings, so nothing renders 'undefined'", () => {
  const p = partnershipFrom(JSON.stringify({
    partnership: { compatibility: 5, summary: "s" },
  }));
  assert.deepEqual(p?.dimensions, []);
  assert.deepEqual(p?.works_well, []);
  assert.equal(p?.role_split.you, "");
  assert.equal(p?.fix_together.change, "");
  assert.equal(p?.role_split.imbalance, null);
});

test("arrays that arrived as something else do not crash the map", () => {
  const p = partnershipFrom(JSON.stringify({
    partnership: { compatibility: 5, summary: "s", dimensions: "none", friction: null },
  }));
  assert.deepEqual(p?.dimensions, []);
  assert.deepEqual(p?.friction, []);
});
