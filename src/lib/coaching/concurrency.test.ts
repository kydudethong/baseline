import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrency } from "./concurrency";

test("results come back in input order, not completion order", async () => {
  // Deliberately inverted: the last item resolves first. If this function
  // collected results as they landed, the output would be reversed.
  const items = [0, 1, 2, 3, 4, 5];
  const got = await mapWithConcurrency(items, 3, async (n) => {
    await new Promise((r) => setTimeout(r, (items.length - n) * 5));
    return n * 10;
  });
  assert.deepEqual(got, [0, 10, 20, 30, 40, 50]);
});

test("never exceeds the limit in flight", async () => {
  let inFlight = 0;
  let peak = 0;
  await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return null;
  });
  assert.ok(peak <= 4, `peak concurrency was ${peak}`);
  assert.ok(peak > 1, "it did not run anything in parallel");
});

test("every item is mapped exactly once", async () => {
  const seen: number[] = [];
  await mapWithConcurrency(Array.from({ length: 13 }, (_, i) => i), 5, async (n) => {
    seen.push(n);
    return n;
  });
  assert.equal(seen.length, 13);
  assert.equal(new Set(seen).size, 13);
});

test("an empty list does no work", async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
});

test("a limit wider than the list is clamped, not padded with idle workers", async () => {
  const got = await mapWithConcurrency([1, 2], 50, async (n) => n * 2);
  assert.deepEqual(got, [2, 4]);
});

test("a limit below one still runs, serially, rather than hanging", async () => {
  const got = await mapWithConcurrency([1, 2, 3], 0, async (n) => n);
  assert.deepEqual(got, [1, 2, 3]);
});

test("a rejecting mapper rejects the whole call rather than silently dropping an item", async () => {
  await assert.rejects(
    () => mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("nope");
      return n;
    }),
    /nope/
  );
});
