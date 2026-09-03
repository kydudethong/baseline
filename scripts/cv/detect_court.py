#!/usr/bin/env python3
"""
Classical-CV court boundary detection. No ML model, no training — pure
color-segmentation + contour geometry. This is deliberately NOT a learned
model: a pickleball court's playing surface is a large, saturated,
consistently-colored quadrilateral (typically two-tone: an in-play color
plus a differently-colored kitchen/non-volley-zone strip) which is
reliably separable from a gym floor / outdoor surround using HSV
thresholds, whereas the surrounding floor and walls in these venues are
often a *third* color that can share hue with either without a stricter
mask.

Honesty contract: if the mask doesn't resolve to a clean, plausible
quadrilateral, this returns confidence 0 and null corners rather than
guessing. Every confidence value returned is derived from measurable
image geometry (contour solidity, corner-count convergence, area
fraction) — nothing is a fixed/faked number.

Usage: detect_court.py <image_path> [--out <json_path>]
Prints JSON to stdout (or writes to --out) shaped like:
{
  "method": "classical-cv-hsv-contour",
  "confidence": 0.0-1.0,
  "cornersImagePx": {"topLeft":[x,y],"topRight":[x,y],"bottomLeft":[x,y],"bottomRight":[x,y]} | null,
  "diagnostics": { ... everything needed to see WHY this confidence was chosen }
}
"""
import sys
import json
import argparse
import numpy as np
import cv2


def order_corners(pts):
    """Given 4 (x,y) points, label them topLeft/topRight/bottomLeft/bottomRight
    in *image* space (y grows downward).

    The classic sum/diff trick (min-sum=topLeft, max-sum=bottomRight, etc.)
    assumes a roughly axis-aligned rectangle. A court shot from behind the
    baseline is a strong trapezoid — its "left" and "right" sides differ
    a lot in length — and that breaks the sum/diff trick (a single point can
    simultaneously hold the min-sum AND max-diff, colliding two labels onto
    one point). Instead: split by y into a top pair / bottom pair, then
    split each pair by x into left/right. Robust to skew, only assumes the
    court isn't rotated more than ~45 degrees in-frame, which "camera
    behind the baseline" guarantees.
    """
    pts = np.array(pts, dtype=np.float32)
    order_by_y = pts[np.argsort(pts[:, 1])]
    top_pair = order_by_y[:2]
    bottom_pair = order_by_y[2:]
    top_left, top_right = sorted(top_pair, key=lambda p: p[0])
    bottom_left, bottom_right = sorted(bottom_pair, key=lambda p: p[0])
    return {
        "topLeft": [float(top_left[0]), float(top_left[1])],
        "topRight": [float(top_right[0]), float(top_right[1])],
        "bottomLeft": [float(bottom_left[0]), float(bottom_left[1])],
        "bottomRight": [float(bottom_right[0]), float(bottom_right[1])],
    }


def detect(image_path: str) -> dict:
    img = cv2.imread(image_path)
    if img is None:
        return {
            "method": "classical-cv-hsv-contour",
            "confidence": 0.0,
            "cornersImagePx": None,
            "diagnostics": {"error": f"could not read image: {image_path}"},
        }

    h, w = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    # In-play surface color band (broad green/blue-green court paint) OR
    # kitchen/non-volley-zone accent color band (broad orange/red paint).
    # Ranges are intentionally wide (real courts vary) but exclude navy/gray
    # walls and pure white lines, which is what made a single-hue mask
    # unreliable in practice — the two-band OR is the actual fix.
    in_play_mask = cv2.inRange(hsv, (35, 40, 40), (95, 255, 255))
    kitchen_mask = cv2.inRange(hsv, (0, 60, 60), (25, 255, 255))
    court_mask = cv2.bitwise_or(in_play_mask, kitchen_mask)

    # Court surface is never in the top quarter of a baseline-behind shot
    # (that's wall/ceiling/lighting rig). Restricting the search window
    # measurably reduces false contours from colored signage.
    roi = np.zeros((h, w), np.uint8)
    roi[int(h * 0.20):, :] = 255
    court_mask = cv2.bitwise_and(court_mask, roi)

    court_mask = cv2.morphologyEx(court_mask, cv2.MORPH_CLOSE, np.ones((21, 21), np.uint8))
    court_mask = cv2.morphologyEx(court_mask, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))

    contours, _ = cv2.findContours(court_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return {
            "method": "classical-cv-hsv-contour",
            "confidence": 0.0,
            "cornersImagePx": None,
            "diagnostics": {"reason": "no contours found after masking", "frameSize": [w, h]},
        }

    # Venues with adjacent courts down a hallway produce multiple same-color
    # blobs. The app's own filming guidance requires the camera centred
    # behind the near baseline, so the court actually being played on is the
    # one whose contour reaches furthest toward the bottom of the frame —
    # not necessarily the one with the largest raw area (a merged blob of
    # several distant courts can out-area the single near one).
    min_area = 0.02 * w * h
    candidates = [c for c in contours if cv2.contourArea(c) >= min_area]
    if not candidates:
        return {
            "method": "classical-cv-hsv-contour",
            "confidence": 0.0,
            "cornersImagePx": None,
            "diagnostics": {"reason": "no contour cleared the minimum area threshold", "frameSize": [w, h]},
        }

    def bottom_extent(contour):
        _, y, _, ch = cv2.boundingRect(contour)
        return y + ch

    c = max(candidates, key=bottom_extent)
    area = cv2.contourArea(c)
    area_frac = area / (w * h)

    hull = cv2.convexHull(c)
    hull_area = cv2.contourArea(hull)
    solidity = (area / hull_area) if hull_area > 0 else 0.0
    peri = cv2.arcLength(hull, True)

    approx = None
    used_eps = None
    for eps_frac in (0.015, 0.02, 0.025, 0.03, 0.04):
        candidate = cv2.approxPolyDP(hull, eps_frac * peri, True)
        if len(candidate) == 4:
            approx = candidate
            used_eps = eps_frac
            break

    diagnostics = {
        "frameSize": [w, h],
        "largestContourAreaFraction": round(float(area_frac), 4),
        "solidity": round(float(solidity), 4),
        "approxEpsilonUsed": used_eps,
    }

    # Minimum plausibility gates — a real court fills a meaningful chunk of
    # frame and is a reasonably convex/solid shape. Below these, don't guess.
    if approx is None or area_frac < 0.03 or solidity < 0.5:
        diagnostics["reason"] = (
            "no 4-corner polygon approximation converged" if approx is None
            else "contour too small or not solid enough to trust"
        )
        return {
            "method": "classical-cv-hsv-contour",
            "confidence": 0.0,
            "cornersImagePx": None,
            "diagnostics": diagnostics,
        }

    corners = order_corners(approx.reshape(-1, 2).tolist())

    # Confidence: blend of solidity (how convex/clean the shape is), area
    # fraction (bigger, closer to canonical broadcast framing = more
    # reliable), and how tight an epsilon converged to 4 points (tighter =
    # more genuinely quadrilateral, not a coincidence of loose tolerance).
    eps_score = 1.0 - (used_eps - 0.015) / (0.04 - 0.015)  # 1.0 best .. 0.0 worst
    area_score = min(1.0, area_frac / 0.15)  # saturates at 15% of frame
    confidence = float(np.clip(0.45 * solidity + 0.35 * area_score + 0.20 * eps_score, 0.0, 1.0))

    return {
        "method": "classical-cv-hsv-contour",
        "confidence": round(confidence, 3),
        "cornersImagePx": corners,
        "diagnostics": diagnostics,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("image_path")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    result = detect(args.image_path)
    out_json = json.dumps(result)
    if args.out:
        with open(args.out, "w") as f:
            f.write(out_json)
    else:
        print(out_json)
