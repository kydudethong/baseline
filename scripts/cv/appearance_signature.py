#!/usr/bin/env python3
"""
Per-detection colour signature — a cheap appearance cue the roster uses to tell
two players apart when geometry alone is ambiguous.

THREE BANDS, NOT ONE, and that is the whole point of this file. It used to
sample the torso only — deliberately, "what colour shirt are they wearing is
almost always enough to tell two doubles partners apart". That reasoning has an
obvious hole in it and rec pickleball walks straight through: partners in
matching kit. Sampling only the shirt does not degrade gracefully there, it
zeroes the signal out, and the tracker is left with geometry for the one case
geometry finds hardest — two people on the same side of the net, close
together.

So each box is sampled in three horizontal bands:

  head   the top of the box: hair, hat, skin. Rarely matched even by people
         who bought the same shirt.
  torso  the shirt, as before.
  legs   shorts, socks, shoes. Shoes in particular are almost never identical.

Compared as a vector (see appearanceDistance in roster.ts). When two players
are in the same shirt the torso term goes to zero and contributes nothing to
the difference, so the head and leg bands decide it on their own — no
special-casing needed, that falls out of a weighted mean.

Still deliberately not a learned re-ID embedding: with at most two candidates
on a known side of a known court, this is a tie-breaker, not a biometric.

Batched across every frame in ONE process (mirrors estimate_pose.py) — this is
classical CV (numpy/cv2), so nearly all of the per-frame cost was Python
interpreter and import startup rather than the work itself.

Usage: appearance_signature.py < requests_json  (reads JSON from stdin)
  requests_json: JSON array of {"imagePath": str, "boxes": [{"x","y","width","height"}, ...]}
  boxes are 0-1 normalized, top-left-origin image coordinates (same
  convention as BoundingBoxNorm in phase2-types.ts).
Prints one JSON line per request to stdout, in the same order:
  {"imagePath": str, "signatures": [{"head","torso","legs"} | null, ...]}
  each band being {"h","s","v"} (h in degrees 0-360, s/v in 0-1) or null when
  that band could not be sampled. A signature is null only when NO band could.
"""
import sys
import json
import numpy as np
import cv2


# Each band as (top, bottom, inset) in fractions of the box.
#
# The insets differ because the regions taper differently: a head occupies the
# middle of the box's width, a torso rather more of it, and legs narrow again.
# Taking a constant inset pulled background court into the head band, which is
# the band most likely to be the deciding one when the shirts match.
BANDS = (
    ("head", 0.00, 0.18, 0.25),
    ("torso", 0.25, 0.60, 0.20),
    ("legs", 0.62, 1.00, 0.22),
)


def band_mean(hsv, w, h, box, top, bottom, inset):
    """Mean HSV of one horizontal band of a box, or None if unsampleable."""
    x = box["x"] * w
    y = box["y"] * h
    bw = box["width"] * w
    bh = box["height"] * h

    x1 = int(np.clip(x + inset * bw, 0, w - 1))
    x2 = int(np.clip(x + (1.0 - inset) * bw, 0, w - 1))
    y1 = int(np.clip(y + top * bh, 0, h - 1))
    y2 = int(np.clip(y + bottom * bh, 0, h - 1))
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
        # shirt) -- fall back to using every pixel in the band rather
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


def signature_for_box(hsv, w, h, box):
    out = {name: band_mean(hsv, w, h, box, top, bottom, inset)
           for (name, top, bottom, inset) in BANDS}
    # A signature with every band missing is no signature. One with a missing
    # band is still useful, and saying which band is missing is better than
    # dropping the rest: the comparison simply skips it.
    if all(v is None for v in out.values()):
        return None
    return out


def signatures_for_image(image_path, boxes):
    img = cv2.imread(image_path)
    if img is None:
        return [None] * len(boxes)
    h, w = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    return [signature_for_box(hsv, w, h, box) for box in boxes]


def main():
    requests = json.loads(sys.stdin.read())
    for req in requests:
        try:
            sigs = signatures_for_image(req["imagePath"], req["boxes"])
        except Exception as exc:  # noqa: BLE001 -- surface as data per-frame, not a crash
            print(json.dumps({"imagePath": req["imagePath"], "error": str(exc), "signatures": [None] * len(req["boxes"])}))
            continue
        print(json.dumps({"imagePath": req["imagePath"], "signatures": sigs}))


if __name__ == "__main__":
    main()
