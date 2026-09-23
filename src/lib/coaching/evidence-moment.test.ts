import { test } from "node:test";
import assert from "node:assert/strict";
import { momentFor } from "./evidence-moment";

const contacts = [4.0, 6.2, 8.5, 9.9];

test("a named time near a swing becomes that swing", () => {
  const m = momentFor({ namedSeconds: 6.0, contactSeconds: contacts, rally: { start: 3, end: 11 } });
  assert.equal(m.kind, "moment");
  assert.equal(m.kind === "moment" && m.tSeconds, 6.2, "snapped to the measured contact");
});

test("a time in dead air is refused, and the rally is shown instead", () => {
  // THE REPORTED BUG: a straight-leg criticism came with footage of the
  // players standing up after the point had finished.
  const m = momentFor({ namedSeconds: 14.5, contactSeconds: contacts, rally: { start: 3, end: 11 } });
  assert.equal(m.kind, "rally");
  assert.equal(m.kind === "rally" && m.tSeconds, 3);
  assert.equal(m.kind === "rally" && m.endSeconds, 11);
  assert.match(m.kind === "rally" ? m.reason : "", /no play in it/);
});

test("dead air with no rally to fall back on shows nothing at all", () => {
  const m = momentFor({ namedSeconds: 14.5, contactSeconds: contacts, rally: null });
  assert.equal(m.kind, "none");
});

test("no time named means the whole point", () => {
  const m = momentFor({ namedSeconds: null, contactSeconds: contacts, rally: { start: 3, end: 11 } });
  assert.equal(m.kind, "rally");
  assert.equal(m.kind === "rally" && m.reason, "no time named");
});

test("a clip where nothing was measured keeps the named time", () => {
  // Measuring no contacts is normal on hard footage. Refusing every cited
  // moment there would leave those reads with no evidence at all.
  const m = momentFor({ namedSeconds: 14.5, contactSeconds: [], rally: null });
  assert.equal(m.kind, "moment");
  assert.equal(m.kind === "moment" && m.tSeconds, 14.5);
});

test("a rally with no length is not a rally", () => {
  const m = momentFor({ namedSeconds: null, contactSeconds: contacts, rally: { start: 5, end: 5 } });
  assert.equal(m.kind, "none");
});
