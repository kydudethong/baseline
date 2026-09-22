import test from "node:test";
import assert from "node:assert/strict";
import { readEmail, escapeHtml } from "./read-email";

const URL_ = "https://example.com/dashboard/abc";

test("the subject leads with the read's own headline", () => {
  // "Your analysis is ready" is what every app sends and everyone ignores.
  const e = readEmail({ kind: "ready", title: "IMG_5643", headline: "Bend more on dinks", url: URL_ });
  assert.match(e.subject, /Bend more on dinks/);
});

test("with no headline it still says what is ready", () => {
  const e = readEmail({ kind: "ready", title: "IMG_5643", headline: null, url: URL_ });
  assert.match(e.subject, /IMG_5643.*ready/);
});

test("both parts carry the link", () => {
  const e = readEmail({ kind: "ready", title: "t", headline: "h", url: URL_ });
  assert.ok(e.text.includes(URL_));
  assert.ok(e.html.includes(URL_));
});

test("a failure says so and says re-running is free", () => {
  const e = readEmail({ kind: "failed", title: "IMG_5643", headline: null, url: URL_ });
  assert.match(e.subject, /didn't finish/);
  assert.match(e.text, /doesn't use any of your minutes/);
});

test("the file name and the headline cannot inject HTML", () => {
  // The title is the user's own file name; the headline is model output.
  // Neither is trusted markup.
  const e = readEmail({
    kind: "ready", title: "<img src=x onerror=alert(1)>", headline: "<script>x</script>", url: URL_,
  });
  assert.doesNotMatch(e.html, /<script>|<img/);
  assert.match(e.html, /&lt;script&gt;/);
});

test("a long headline is clipped to fit an inbox subject line", () => {
  const e = readEmail({ kind: "ready", title: "t", headline: "x".repeat(200), url: URL_ });
  assert.ok(e.subject.length <= 70, `${e.subject.length} chars`);
  assert.ok(e.subject.endsWith("…"));
});

test("escapeHtml handles every character that matters in an attribute", () => {
  assert.equal(escapeHtml(`a&b<c>"d'`), "a&amp;b&lt;c&gt;&quot;d&#39;");
});
