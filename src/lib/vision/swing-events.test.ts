import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSwingEvents, swingsToUnknownShotEvents } from "./swing-events";
import type { PlayerPoseFrame, PoseKeypoint } from "./phase2-types";

/**
 * A skeleton with shoulders a fixed width apart and a right wrist wherever the
 * caller puts it. The left wrist is parked, which is the normal case -- one
 * hand holds the paddle.
 */
function pose(playerId: string, t: number, wristX: number, wristY = 0.5): PlayerPoseFrame {
  const kp = (name: string, x: number, y: number): PoseKeypoint =>
    ({ name: name as PoseKeypoint["name"], xNorm: x, yNorm: y, confidence: 0.9 });
  return {
    playerId,
    timestampSeconds: t,
    detectionConfidence: 0.9,
    modelSource: "yolov8n-pose",
    keypoints: [
      kp("left_shoulder", 0.48, 0.4),
      kp("right_shoulder", 0.58, 0.4),   // 0.10 of the frame: the ruler
      kp("left_wrist", 0.47, 0.55),
      kp("right_wrist", wristX, wristY),
    ],
  };
}

/** A hand drifting gently, with one sharp acceleration at `swingAt`. */
function rally(playerId: string, frames: number, swingAt: number[], dt = 0.2): PlayerPoseFrame[] {
  const out: PlayerPoseFrame[] = [];
  let x = 0.5;
  for (let i = 0; i < frames; i++) {
    // Idle drift: a couple of hundredths of a shoulder width per frame.
    x += swingAt.includes(i) ? 0.09 : (i % 2 ? 0.004 : -0.004);
    out.push(pose(playerId, i * dt, x));
  }
  return out;
}

test("a sharp wrist acceleration is a contact; idle hands are not", () => {
  const got = detectSwingEvents(rally("player_1", 24, [6, 14]));
  assert.equal(got.length, 2, `got ${got.length} contacts: ${got.map((g) => g.timestampSeconds).join(", ")}`);
  assert.deepEqual(got.map((g) => g.timestampSeconds), [1.2, 2.8]);
  for (const g of got) assert.equal(g.playerId, "player_1");
});

test("a player who never swings produces nothing at all", () => {
  // AND NOTHING IS THE RIGHT ANSWER. A learned threshold sits at the player's
  // own median plus four MADs, and for somebody standing still that is a
  // vanishingly small number -- so without the absolute floor every twitch of
  // a warm-up would be filed as a paddle contact and measured for knee angle.
  //
  // THE IDLE MOTION HAS TO BE NOISY for this to test anything. The first
  // version drifted by a constant amount each frame, which gives a median
  // absolute deviation of exactly zero; every sample then ties, no sample can
  // be prominent against its neighbours, and the test passed with the floor
  // deleted. Real fidgeting is uneven, and uneven is what has to be rejected.
  const rnd = lcg(5);
  const idle = [...Array(40)].map(() => 0.2 + rnd() * 1.6); // well under the floor
  const got = detectSwingEvents(atSpeeds("player_1", idle));
  assert.deepEqual(got, [], `invented ${got.length} contacts out of idle fidgeting`);
});

test("a busy pair of hands still needs a real spike to count as a swing", () => {
  // The absolute floor cannot carry this one: a player who keeps their paddle
  // moving between points sits ABOVE it all match. What separates a swing from
  // their ordinary fidget is that it is far above THEIR OWN baseline, which is
  // what the median-plus-four-MADs threshold measures and nothing else does.
  const rnd = lcg(9);
  const speeds = [...Array(40)].map(() => 3.4 + rnd() * 1.8); // busy, but never a stroke
  speeds[11] = 14;
  speeds[27] = 15;
  const got = detectSwingEvents(atSpeeds("player_1", speeds));
  assert.equal(got.length, 2,
    `${got.length} contacts from a busy but strokeless pair of hands with two real swings in them`);
});

test("bending down for a loose ball is not a paddle contact", () => {
  // A player standing almost perfectly still has a median absolute deviation
  // near zero, so their LEARNED threshold collapses to barely above their own
  // median and any movement at all clears it. The absolute floor is the only
  // thing between that and a knee angle being measured at the moment somebody
  // picked a ball up off the court.
  const rnd = lcg(21);
  const speeds = [...Array(40)].map(() => 0.30 + rnd() * 0.04); // all but motionless
  speeds[15] = 1.6;                                             // a slow reach downward
  const got = detectSwingEvents(atSpeeds("player_1", speeds));
  assert.deepEqual(got, [], `a ${1.6} shoulder-width-per-second reach was filed as a stroke`);
});

test("running with the arms pumping is not a stroke", () => {
  // A SWING IS A SPIKE, not a fast passage. Chasing a lob keeps a wrist moving
  // quickly for a second or more, and the top of that broad hump is a local
  // maximum well above the player's own median -- so without a prominence
  // requirement it gets filed as a contact and measured for contact height.
  // What tells the two apart is the shape: a stroke is far faster than the
  // moment either side of it, and a sprint is not.
  const hump = [4, 6, 7.5, 8.3, 8.7, 9, 8.7, 8.3, 7.5, 6, 4];
  const speeds = [...Array(12).fill(4), ...hump, ...Array(12).fill(4)];
  const got = detectSwingEvents(atSpeeds("player_1", speeds));
  assert.deepEqual(got, [], `a broad hump peaking at 9 was filed as ${got.length} contact(s)`);
});

test("one swing is not counted twice", () => {
  // Sampled either side of its peak, a single stroke can clear the bar on two
  // consecutive frames. A player cannot hit twice in half a second -- the ball
  // has to reach an opponent and come back.
  const frames: PlayerPoseFrame[] = [];
  let x = 0.5;
  for (let i = 0; i < 24; i++) {
    if (i === 8 || i === 9) x += 0.07;
    else x += i % 2 ? 0.004 : -0.004;
    frames.push(pose("player_1", i * 0.2, x));
  }
  const got = detectSwingEvents(frames);
  assert.equal(got.length, 1, `one stroke was filed as ${got.length} contacts`);
});

test("players are counted separately, and the list comes back in time order", () => {
  const got = detectSwingEvents([
    ...rally("player_2", 24, [10]),
    ...rally("player_1", 24, [4, 18]),
  ]);
  assert.equal(got.length, 3);
  const times = got.map((g) => g.timestampSeconds);
  assert.deepEqual([...times].sort((a, b) => a - b), times, "not sorted by time");
  assert.deepEqual(got.map((g) => g.playerId), ["player_1", "player_2", "player_1"]);
});

test("a low-confidence wrist is not a fast wrist", () => {
  // A keypoint the model is unsure of jumps around the frame between samples.
  // Treated as a position it is the fastest thing in the clip, and every one
  // of them becomes a shot with body angles attached.
  const frames = rally("player_1", 24, []).map((f, i) => (i === 10
    ? { ...f, keypoints: f.keypoints.map((k) => k.name === "right_wrist"
        ? { ...k, xNorm: 0.95, confidence: 0.1 } : k) }
    : f));
  const got = detectSwingEvents(frames);
  assert.deepEqual(got, [], "a guessed keypoint was read as a swing");
});

test("a gap in the pose stream is not a swing", () => {
  // The player was undetected for a second and the wrist is somewhere else
  // when they come back. Dividing that distance by the gap gives a speed above
  // anything a real arm produces -- an artefact of the gap, not a measurement.
  //
  // THE GAP HAS TO BE SHORT ENOUGH TO BE TEMPTING. A four-second absence makes
  // the implied speed small and the sample is rejected for being slow rather
  // than for being a gap, which is how the first version of this test passed
  // with the guard removed.
  const before = rally("player_1", 12, []);
  const after = rally("player_1", 12, []).map((f) => ({
    ...f,
    timestampSeconds: f.timestampSeconds + 3,
    keypoints: f.keypoints.map((k) => k.name === "right_wrist" ? { ...k, xNorm: 0.05 } : k),
  }));
  // 0.2s of frames, then a 1.0s hole, then the hand 0.45 of a frame away:
  // 4.5 shoulder widths a second, comfortably past the floor, if anything
  // is willing to measure across the hole.
  const reappear = pose("player_1", before[before.length - 1].timestampSeconds + 1.0, 0.05);
  const got = detectSwingEvents([...before, reappear, ...after]);
  assert.deepEqual(got, [], "the reappearance was filed as a contact");
});

test("the events say what they are worth and no more", () => {
  const events = swingsToUnknownShotEvents(detectSwingEvents(rally("player_1", 24, [6, 14])));
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.equal(e.type, "unknown_shot");
    assert.equal(e.source, "movement-heuristic");
    // NOT NEAR-CERTAINTY, ever. Pose at 5fps times a swing to about a fifth of
    // a second and cannot tell a stroke from a hard fake. A confidence above
    // this would be read downstream as something this method cannot know.
    assert.ok(e.confidence <= 0.6 && e.confidence >= 0.1, `confidence ${e.confidence} out of range`);
  }
});/** A reproducible pseudo-random source, so a failure is the same failure twice. */
function lcg(seed: number): () => number {
  let x = seed;
  return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
}

/**
 * A hand moving at a GIVEN SPEED each frame, in shoulder widths per second.
 *
 * Driving the test from speeds rather than from positions is the only way to
 * pin the thresholds: they are all expressed in shoulder widths per second, so
 * a test that sets positions is guessing at the quantity under test. Direction
 * alternates so the hand stays in frame however fast it is moving.
 */
function atSpeeds(playerId: string, speeds: number[], dt = 0.2): PlayerPoseFrame[] {
  const SHOULDER = 0.10;
  const out: PlayerPoseFrame[] = [pose(playerId, 0, 0.5)];
  let x = 0.5;
  speeds.forEach((v, i) => {
    x += (i % 2 ? -1 : 1) * v * SHOULDER * dt;
    out.push(pose(playerId, (i + 1) * dt, x));
  });
  return out;
}


