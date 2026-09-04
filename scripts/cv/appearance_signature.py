#!/usr/bin/env python3
"""
Per-detection color signature — a cheap appearance cue the tracker uses to
re-identify a player whose track was lost (see tracker.ts's
MAX_MISSED_FRAMES_BEFORE_LOST / re-ID window). Deliberately not a learned
re-ID embedding: at 2-4 players and a few hundred sampled frames, "what
color shirt are they wearing" is almost always enough to tell two doubles
partners apart, and it costs one more classical-CV pass, not a model.

For each box, samples the UPPER-CENTER portion of the box (roughly torso/
shirt, avoiding legs — which are frequently in shadow or occluded by the
net/kitchen line — and avoiding the very top, which is often hair/hat) and
returns its mean HSV. This is intentionally coarse: it is a tie-breaker for
"does this new detection plausibly continue that lost track", not a
biometric identifier.

Usage: appearance_signature.py <image_path> <boxes_json>
  boxes_json: JSON array of {"x","y","width","height"} in 0-1 normalized,
  top-left-origin image coordinates (same convention as BoundingBoxNorm in
  phase2-types.ts).
Prints JSON to stdout: array of {"h","s","v"} (h in degrees 0-360, s/v in
0-1) aligned by index to the input boxes, or null for a box that couldn't
be sampled (e.g. it fell entirely outside the frame).
"""
import sys
import json
import numpy as np
import cv2


def signature_for_box(hsv, w, h, box):
    x = box["x"] * w
    y = box["y"] * h
    bw = box["width"] * w
    bh = box["height"] * h

    # Torso strip: horizontally the middle 60% of the box, vertically
    # 25%-60% down from the top (below the head, above the waist/legs).
    x1 = int(np.clip(x + 0.20 * bw, 0, w - 1))
    x2 = int(np.clip(x + 0.80 * bw, 0, w - 1))
    y1 = int(np.clip(y + 0.25 * bh, 0, h - 1))
    y2 = int(np.clip(y + 0.60 * bh, 0, h - 1))

    if x2 <= x1 or y2 <= y1:
        return None

    region = hsv[y1:y2, x1:x2]
    if region.size == 0:
        return None

    # Exclude near-white/near-black/low-saturation pixels (paddle, glare,
    # shadow) from the mean so the signature is dominated by actual
    # clothing color, not lighting artifacts.
    sat = region[:, :, 1]
    val = region[:, :, 2]
    eligible = (sat > 40) & (val > 40) & (val < 250)
    if eligible.sum() < 0.1 * region.shape[0] * region.shape[1]:
        # Not enough colorful pixels to trust (e.g. a plain white/gray
        # shirt) -- fall back to using every pixel in the strip rather
        # than returning nothing.
        eligible = np.ones(sat.shape, dtype=bool)

    hue = region[:, :, 0][eligible].astype(np.float64)  # 0-179
    sat_v = sat[eligible].astype(np.float64)
    val_v = val[eligible].astype(np.float64)

    # Circular mean for hue (it wraps at 180 in OpenCV's 0-179 range).
    angles = hue * 2 * np.pi / 180.0
    mean_angle = np.arctan2(np.mean(np.sin(angles)), np.mean(np.cos(angles)))
    if mean_angle < 0:
        mean_angle += 2 * np.pi
    mean_hue_deg = float(mean_angle * 180.0 / np.pi)  # 0-360

    return {
        "h": round(mean_hue_deg, 1),
        "s": round(float(np.mean(sat_v)) / 255.0, 3),
        "v": round(float(np.mean(val_v)) / 255.0, 3),
    }


def main():
    image_path = sys.argv[1]
    boxes = json.loads(sys.argv[2])

    img = cv2.imread(image_path)
    if img is None:
        print(json.dumps([None] * len(boxes)))
        return

    h, w = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    out = [signature_for_box(hsv, w, h, box) for box in boxes]
    print(json.dumps(out))


if __name__ == "__main__":
    main()
