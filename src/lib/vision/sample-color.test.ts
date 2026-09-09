import assert from "node:assert/strict";
import test from "node:test";

import { rgbToHex, sampleLineColor } from "./sample-color";

/** A `width` x `height` RGBA buffer painted `surface`, with a vertical line
 *  `lineWidth` px wide in `line` centred at x = `lineX`. */
function frame(
  width: number, height: number,
  surface: [number, number, number], line: [number, number, number],
  lineX: number, lineWidth = 3
): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(width * height * 4);
  const half = Math.floor(lineWidth / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const onLine = x >= lineX - half && x <= lineX + half;
      const [r, g, b] = onLine ? line : surface;
      const i = (y * width + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  return buf;
}

const GREEN: [number, number, number] = [60, 120, 70];
const BLUE: [number, number, number] = [20, 90, 200];

test("a click on the line returns the line's colour, not the court's", () => {
  const buf = frame(40, 40, GREEN, BLUE, 20);
  const got = sampleLineColor(buf, 40, 40, 20, 20);
  assert.equal(got?.hex, rgbToHex(...BLUE));
});

test("the surrounding court does not drag the sample toward itself", () => {
  // The whole point: a 5x5 patch on a 3px line is mostly court. A mean or a
  // median over that patch would return something greenish.
  const buf = frame(40, 40, GREEN, BLUE, 20);
  const got = sampleLineColor(buf, 40, 40, 20, 20);
  const [r, g, b] = [
    parseInt(got!.hex.slice(1, 3), 16),
    parseInt(got!.hex.slice(3, 5), 16),
    parseInt(got!.hex.slice(5, 7), 16),
  ];
  assert.ok(b > r && b > g, `expected a blue sample, got ${got!.hex}`);
});

test("compression noise around the line is averaged out", () => {
  const buf = frame(40, 40, GREEN, BLUE, 20);
  // Jitter the line pixels the way an 8-bit encode would.
  for (let y = 0; y < 40; y++) {
    const i = (y * 40 + 20) * 4;
    buf[i] += y % 2 ? 6 : -6;
    buf[i + 2] += y % 3 ? -5 : 5;
  }
  const got = sampleLineColor(buf, 40, 40, 20, 20);
  const b = parseInt(got!.hex.slice(5, 7), 16);
  assert.ok(Math.abs(b - 200) <= 6, `expected ~200 blue, got ${b}`);
});

test("agreement is low on a thin line and high on open court", () => {
  const buf = frame(40, 40, GREEN, BLUE, 20);
  const onLine = sampleLineColor(buf, 40, 40, 20, 20)!;
  const onCourt = sampleLineColor(buf, 40, 40, 5, 20)!;
  assert.ok(onCourt.agreement > 0.95, "open court should agree with itself");
  assert.ok(onLine.agreement < 0.8, "a 3px line cannot fill a 5x5 patch");
});

test("a click outside the buffer is refused rather than clamped", () => {
  const buf = frame(10, 10, GREEN, BLUE, 5);
  assert.equal(sampleLineColor(buf, 10, 10, -3, 5), null);
  assert.equal(sampleLineColor(buf, 10, 10, 5, 40), null);
  assert.equal(sampleLineColor(buf, 10, 10, Number.NaN, 5), null);
});

test("a click at the very edge still samples, using the pixels that exist", () => {
  const buf = frame(10, 10, GREEN, BLUE, 5);
  const got = sampleLineColor(buf, 10, 10, 0, 0);
  assert.equal(got?.hex, rgbToHex(...GREEN));
});

test("hex is lowercase and always six digits", () => {
  assert.equal(rgbToHex(0, 0, 0), "#000000");
  assert.equal(rgbToHex(255, 255, 255), "#ffffff");
  assert.equal(rgbToHex(10, 11, 12), "#0a0b0c");
});

test("out-of-range channels are clamped rather than producing bad hex", () => {
  assert.equal(rgbToHex(-20, 300, 128.6), "#00ff81");
});
