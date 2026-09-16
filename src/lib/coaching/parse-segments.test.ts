import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSegments } from "./batch-collect";

test("a segment that will not parse is dropped, not thrown", () => {
  // One malformed answer out of five should cost a fifth of the analysis, not
  // all of it. After an overnight wait, the difference between four segments
  // and starting again is another day.
  const logged: string[] = [];
  const out = parseSegments(
    ['{"rallies":[]}', "not json at all", '{"rallies":[{"idx":1}]}'],
    (l) => logged.push(l)
  );
  assert.equal(out.length, 2);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /segment 2/);
});

test("the dropped segment is named by its position, not its index", () => {
  // "segment 0" sends somebody looking for a segment that does not exist in
  // any log, any UI or any conversation about the run.
  const logged: string[] = [];
  parseSegments(["{}", "<html>"], (l) => logged.push(l));
  assert.match(logged[0], /segment 2\b/);
});

test("all-bad input yields nothing rather than throwing", () => {
  // The caller turns an empty result into a failed analysis with a reason. A
  // throw here would lose that distinction and surface as a crash.
  assert.deepEqual(parseSegments(["nope", "also nope"]), []);
});

test("good input passes straight through, in order", () => {
  const out = parseSegments(['{"a":1}', '{"a":2}']);
  assert.deepEqual(out.map((o) => (o as unknown as { a: number }).a), [1, 2]);
});
