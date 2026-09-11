import assert from "node:assert/strict";
import test from "node:test";

import { buildAnalystInput, contactsFromShots, toFeet } from "./analyst-facts";
import type { AnalysisShotRow, BallTrackRow } from "@/lib/db/types";

function shot(over: Partial<AnalysisShotRow> = {}): AnalysisShotRow {
  return {
    id: "s1", analysis_id: "a1", rally_idx: 1, shot_idx: 0,
    timestamp_s: 12.345, player_label: "player_2", shot_type: "dink",
    category: "kitchen", confidence: 0.7,
    hit_court: { x: 0.5, y: 0.75 }, hit_zone: "kitchen",
    landing_court: { x: 0.4, y: 0.3 }, landing_zone: "kitchen",
    speed_mps_approx: 6.2, arc_norm: null, bounced_before: false,
    outcome: "in", features: {}, mechanics: null,
    ...over,
  } as AnalysisShotRow;
}

test("normalised court positions become feet, with y away from the camera", () => {
  // y is stored with the NEAR baseline at 1. Describing it as feet without
  // flipping would put every near-court shot at the far baseline.
  assert.deepEqual(toFeet({ x: 0.5, y: 1 }), { x_ft: 10, y_ft: 0 });     // near baseline
  assert.deepEqual(toFeet({ x: 0.5, y: 0.5 }), { x_ft: 10, y_ft: 22 });  // the net
  assert.deepEqual(toFeet({ x: 0, y: 0 }), { x_ft: 0, y_ft: 44 });       // far baseline
});

test("a missing or non-finite position yields nothing, not a zero", () => {
  assert.equal(toFeet(null), undefined);
  assert.equal(toFeet(undefined), undefined);
  assert.equal(toFeet({ x: Number.NaN, y: 0.5 }), undefined);
});

test("contacts are sorted by time and carry no rally or shot type", () => {
  // The whole point of this module. Handing our rally grouping or our shot
  // labels to the thing being asked to produce them stops it being a question.
  const got = contactsFromShots([
    shot({ timestamp_s: 20, shot_idx: 1 }),
    shot({ timestamp_s: 4, shot_idx: 0 }),
  ]);
  assert.deepEqual(got.map((c) => c.t), [4, 20]);
  const blob = JSON.stringify(got);
  assert.ok(!blob.includes("rally"), "no rally grouping");
  assert.ok(!blob.includes("dink"), "no shot type");
  assert.ok(!blob.includes("kitchen"), "no zone label derived from our grouping");
});

test("mechanics are trimmed to what a coach can act on, and rounded", () => {
  const got = contactsFromShots([shot({
    mechanics: {
      kneeAngleAtContactDeg: 176.23045088276567,
      hand: "right",
      samples: 14, confidence: 0.95, missing: ["shoulderRotationDeg"],
    } as never,
  })]);
  assert.deepEqual(got[0].body, { kneeAngleAtContactDeg: 176.23, hand: "right" });
});

test("a contact with no mechanics carries no body block at all", () => {
  // Absent, not null-filled. A coach handed {knee_angle: null} writes about
  // technique anyway.
  const got = contactsFromShots([shot({ mechanics: null })]);
  assert.equal("body" in got[0], false);
});

function input(over: Parameters<typeof buildAnalystInput>[0] | object = {}) {
  return buildAnalystInput({
    clipSeconds: 101.34,
    subjectPlayerId: "player_2",
    shots: [shot()],
    ballTrack: { coverage: 0.62 } as BallTrackRow,
    movement: [],
    courtConfidence: 0.74,
    skillLevel: "3.5",
    focusArea: null,
    drillCatalogue: [],
    ...over,
  } as Parameters<typeof buildAnalystInput>[0]);
}

test("thin ball coverage becomes a stated limitation, not an inference", () => {
  // A coverage number the model cannot see is a caveat it cannot apply. The
  // measured run was 28%, so this is the normal case, not an edge one.
  const got = input({ ballTrack: { coverage: 0.28 } as BallTrackRow });
  assert.ok(got.knownLimitations.some((l) => /only visible in 28%/.test(l)));
  assert.ok(got.knownLimitations.some((l) => /not evidence that nothing happened/.test(l)));
});

test("good coverage adds no such warning", () => {
  assert.equal(input().knownLimitations.some((l) => /only visible/.test(l)), false);
});

test("no body measurements anywhere is stated outright", () => {
  const got = input({ shots: [shot({ mechanics: null })] });
  assert.ok(got.knownLimitations.some((l) => /nothing can be said about technique/.test(l)));
});

test("no subject is stated outright", () => {
  // The bug a VLM found by watching the overlay: with no subject, coaching
  // describes whichever player the reader picks.
  const got = input({ subjectPlayerId: null });
  assert.ok(got.knownLimitations.some((l) => /cannot be addressed to one person/.test(l)));
});

test("caller-supplied limitations survive alongside the derived ones", () => {
  const got = input({
    ballTrack: { coverage: 0.28 } as BallTrackRow,
    knownLimitations: ["the far baseline was outside the frame"],
  });
  assert.ok(got.knownLimitations.includes("the far baseline was outside the frame"));
  assert.ok(got.knownLimitations.length > 1);
});

test("a long clip gets an explicit warning about inventing time", () => {
  // One call for the whole video is the chosen design, so the defence against
  // the model drifting has to live in the prompt and the audit rather than in
  // chunking. This is the prompt half.
  const short = input({ clipSeconds: 101.3 });
  assert.equal(short.knownLimitations.some((l) => /minutes long/.test(l)), false);

  const long = input({ clipSeconds: 90 * 60 });
  const warning = long.knownLimitations.find((l) => /minutes long/.test(l));
  assert.ok(warning, "expected a long-clip warning");
  assert.match(warning!, /90 minutes/);
  assert.match(warning!, /do not report anything after 5400s/);
});
