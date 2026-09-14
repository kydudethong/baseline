import { test } from "node:test";
import assert from "node:assert/strict";
import { describeError } from "./describe-error";

test("a plain Error is its message", () => {
  assert.equal(describeError(new Error("boom")), "boom");
});

test("a Supabase-shaped plain object keeps message, details, hint and code", () => {
  const got = describeError({ message: "duplicate key", details: "Key (id)=(1) exists", hint: "use upsert", code: "23505" });
  assert.match(got, /duplicate key/);
  assert.match(got, /Key \(id\)=\(1\) exists/);
  assert.match(got, /Hint: use upsert/);
  assert.match(got, /\[23505\]/);
});

test("an undici network failure names the syscall code, not just 'fetch failed'", () => {
  // The whole point: "fetch failed" is identical for DNS failure, refused
  // connection, reset socket and TLS error. The cause is what tells them apart.
  const err = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND generativelanguage.googleapis.com"), { code: "ENOTFOUND" }) });
  const got = describeError(err);
  assert.match(got, /fetch failed/);
  assert.match(got, /ENOTFOUND/);
  assert.match(got, /generativelanguage/);
});

test("a reset socket is distinguishable from a DNS failure", () => {
  const dns = describeError(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ENOTFOUND" }) }));
  const reset = describeError(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) }));
  assert.notEqual(dns, reset);
});

test("a nested cause chain is followed", () => {
  const inner = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const middle = new Error("upload failed", { cause: inner });
  const outer = new TypeError("fetch failed", { cause: middle });
  const got = describeError(outer);
  assert.match(got, /fetch failed/);
  assert.match(got, /upload failed/);
  assert.match(got, /ECONNRESET/);
});

test("a cyclic cause chain terminates", () => {
  const a: Error & { cause?: unknown } = Object.assign(new Error("a"), { code: "A" });
  const b: Error & { cause?: unknown } = Object.assign(new Error("b"), { code: "B" });
  a.cause = b;
  b.cause = a;
  const got = describeError(new TypeError("fetch failed", { cause: a }));
  assert.match(got, /fetch failed/);
  assert.ok(got.length < 400, "a cycle must not run away");
});

test("an Error with no cause is unchanged — no trailing separator", () => {
  assert.equal(describeError(new Error("plain")), "plain");
});

test("a cause carrying nothing useful is skipped rather than printed empty", () => {
  assert.equal(describeError(new TypeError("fetch failed", { cause: {} })), "fetch failed");
});

test("an error with no message at all still says something", () => {
  assert.match(describeError({}), /carried no message/);
});
