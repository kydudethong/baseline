import assert from "node:assert/strict";
import test from "node:test";

import { sanitiseSchema } from "./gemini";

test("a Claude-dialect nullable becomes a Gemini nullable", () => {
  // This exact mismatch cost a round trip: ["array","null"] is how Claude's
  // structured outputs express "may be null", and Gemini rejects it outright
  // rather than ignoring it.
  const got = sanitiseSchema({ type: ["array", "null"], items: { type: "number" } }) as Record<string, unknown>;
  assert.equal(got.type, "array");
  assert.equal(got.nullable, true);
  assert.deepEqual(got.items, { type: "number" });
});

test("a plain type array with no null keeps its first type and is not nullable", () => {
  const got = sanitiseSchema({ type: ["string"] }) as Record<string, unknown>;
  assert.equal(got.type, "string");
  assert.equal(got.nullable, undefined);
});

test("additionalProperties is stripped, not passed through", () => {
  // Claude REQUIRES it on every object; Gemini rejects it. A schema shared
  // between the two would fail on one of them without this.
  const got = sanitiseSchema({
    type: "object",
    additionalProperties: false,
    properties: { a: { type: "object", additionalProperties: false, properties: {} } },
  }) as Record<string, unknown>;
  assert.equal("additionalProperties" in got, false);
  const inner = (got.properties as Record<string, Record<string, unknown>>).a;
  assert.equal("additionalProperties" in inner, false);
});

test("it recurses through arrays and nested objects", () => {
  const got = sanitiseSchema({
    type: "object",
    properties: {
      rallies: {
        type: "array",
        items: { type: "object", additionalProperties: false,
                 properties: { winner: { type: ["string", "null"] } } },
      },
    },
  }) as Record<string, unknown>;
  const items = ((got.properties as Record<string, Record<string, unknown>>).rallies
    .items) as Record<string, unknown>;
  assert.equal("additionalProperties" in items, false);
  const winner = (items.properties as Record<string, Record<string, unknown>>).winner;
  assert.equal(winner.type, "string");
  assert.equal(winner.nullable, true);
});

test("a schema already in the Gemini dialect passes through unchanged", () => {
  const original = {
    type: "object",
    properties: { ball: { type: "array", nullable: true, items: { type: "number" } } },
    required: ["ball"],
  };
  assert.deepEqual(sanitiseSchema(structuredClone(original)), original);
});

test("primitives and nulls survive", () => {
  assert.equal(sanitiseSchema("x"), "x");
  assert.equal(sanitiseSchema(7), 7);
  assert.equal(sanitiseSchema(null), null);
  assert.deepEqual(sanitiseSchema([1, "a"]), [1, "a"]);
});
