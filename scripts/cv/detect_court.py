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

Two known failure modes, fixed here (previously documented as an open
known limitation — see PHASE2_DELIVERABLES.md / PHASE3_DELIVERABLES.md):

1. Fixed HSV hue bands. The original detector only tried one green/blue-
   green "in-play" band and one orange/red "kitchen" band. A court painted
   in a third palette (purple, pink, plain gray/blue) never matched either
   band on ANY candidate frame, so run-vision-pipeline.ts's multi-frame
   retry couldn't help — every frame failed alike. Fix: when the fixed
   bands don't produce a usable quad, fall back to an *auto-detected*
   dominant-color mask — cluster the lower 80% of the frame's hue
   histogram and build a mask from whichever hue actually dominates a
   large, contiguous region, rather than only ever trying two guesses.

2. Strict 4-point polygon requirement. `approxPolyDP` refusing to
   converge to exactly 4 points (a player standing on a corner, a soft
   shadow rounding a corner, mild lens distortion) meant a real, usable
   quadrilateral silently produced confidence 0. Fix: when no epsilon
   converges to 4 points, fall back to the hull's minimum-area rotated
   rectangle (`cv2.minAreaRect`) as the corner set — coarser than a true
   polygon fit, so it's penalized in the confidence score, but it's a real
   measured rectangle around the actual masked region rather than nothing.

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


def fixed_band_mask(hsv):
    """The original two hardcoded hue bands — cheap, and correct for most
    real courts, so still tried first."""
    in_play_mask = cv2.inRange(hsv, (35, 40, 40), (95, 255, 255))
    kitchen_mask = cv2.inRange(hsv, (0, 60, 60), (25, 255, 255))
    return cv2.bitwise_or(in_play_mask, kitchen_mask)


def auto_dominant_mask(hsv, roi):
    """Court color, whatever it actually is, found from the image itself
    instead of guessed. Builds a hue histogram over the search ROI
    (excluding low-saturation/low-value pixels — those are white lines,
    shadow, and near-black/near-gray surrounds, never a painted playing
    surface), finds the tallest histogram peak, and masks a +/-10 degree
    hue window around it. This is deliberately a *second* attempt, only
    used when the fixed bands fail — a histogram peak on a cluttered
    background (bleachers, a crowd) could pick the wrong color, so it
    still has to clear the same solidity/area gates as everything else
    before it's trusted.
    """
    mask_roi = np.zeros(hsv.shape[:2], np.uint8)
    mask_roi[roi > 0] = 255
    sat_val_mask = cv2.inRange(hsv, (0, 60, 50), (179, 255, 255))
    eligible = cv2.bitwise_and(mask_roi, sat_val_mask)

    hist = cv2.calcHist([hsv], [0], eligible, [180], [0, 180]).flatten()
    if hist.sum() < 500:  # not enough saturated pixels to trust a peak
        return None, None
    peak_hue = int(np.argmax(hist))

    lower_h = max(0, peak_hue - 10)
    upper_h = min(179, peak_hue + 10)
    mask = cv2.inRange(hsv, (lower_h, 60, 50), (upper_h, 255, 255))
    return mask, peak_hue


def quad_from_contour(c, w, h):
    """Contour -> 4 image-space corners + how confident that fit is.
    Returns None if the contour doesn't clear basic plausibility gates.
    """
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

    corner_method = "polygon"
    if approx is None:
        # Fallback: the hull's minimum-area rotated rectangle always has
        # exactly 4 points. Coarser than a true polygon fit (it can't
        # represent a non-rectangular trapezoid as tightly), so it's
        # penalized below via min_area_rect_penalty rather than scored
        # the same as a converged polygon fit.
        rect = cv2.minAreaRect(hull)
        box = cv2.boxPoints(rect)
        approx = box.reshape(-1, 1, 2).astype(np.float32)
        used_eps = 0.04  # worst-case epsilon score, since this isn't a real polygon convergence
        corner_method = "minAreaRect"

    diagnostics = {
        "areaFraction": round(float(area_frac), 4),
        "solidity": round(float(solidity), 4),
        "approxEpsilonUsed": used_eps,
        "cornerMethod": corner_method,
    }

    if area_frac < 0.03 or solidity < 0.5:
        diagnostics["reason"] = "contour too small or not solid enough to trust"
        return None, diagnostics

    corners = order_corners(approx.reshape(-1, 2).tolist())

    eps_score = 1.0 - (used_eps - 0.015) / (0.04 - 0.015)
    area_score = min(1.0, area_frac / 0.15)
    confidence = float(np.clip(0.45 * solidity + 0.35 * area_score + 0.20 * eps_score, 0.0, 1.0))
    if corner_method == "minAreaRect":
        confidence *= 0.85  # a real fallback, but a coarser one than a converged polygon

    diagnostics["confidence"] = round(confidence, 3)
    return {"corners": corners, "confidence": confidence}, diagnostics


def best_quad_from_mask(mask, w, h):
    """Full contour pipeline (find contours -> pick the one reaching
    furthest down the frame -> fit a quad) for one candidate mask. Returns
    (result_or_None, diagnostics)."""
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((21, 21), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None, {"reason": "no contours found after masking"}

    min_area = 0.02 * w * h
    candidates = [c for c in contours if cv2.contourArea(c) >= min_area]
    if not candidates:
        return None, {"reason": "no contour cleared the minimum area threshold"}

    def bottom_extent(contour):
        _, y, _, ch = cv2.boundingRect(contour)
        return y + ch

    # Venues with adjacent courts down a hallway produce multiple same-color
    # blobs. The app's own filming guidance requires the camera centred
    # behind the near baseline, so the court actually being played on is the
    # one whose contour reaches furthest toward the bottom of the frame —
    # not necessarily the one with the largest raw area (a merged blob of
    # several distant courts can out-area the single near one).
    c = max(candidates, key=bottom_extent)
    return quad_from_contour(c, w, h)


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

    # Court surface is never in the top quarter of a baseline-behind shot
    # (that's wall/ceiling/lighting rig). Restricting the search window
    # measurably reduces false contours from colored signage.
    roi = np.zeros((h, w), np.uint8)
    roi[int(h * 0.20):, :] = 255

    attempts = {}

    fixed_mask = cv2.bitwise_and(fixed_band_mask(hsv), roi)
    fixed_result, fixed_diag = best_quad_from_mask(fixed_mask, w, h)
    attempts["fixedBands"] = fixed_diag

    best_result = fixed_result
    best_source = "fixedBands" if fixed_result else None

    # Only spend the auto-detection pass when the fixed bands didn't
    # already produce a confident result — most real courts match the
    # fixed bands, and this keeps the common case exactly as cheap as
    # before.
    if best_result is None or best_result["confidence"] < 0.5:
        auto_mask, peak_hue = auto_dominant_mask(hsv, roi)
        if auto_mask is not None:
            auto_result, auto_diag = best_quad_from_mask(auto_mask, w, h)
            auto_diag["peakHueDegrees"] = round(peak_hue * 2, 1)  # OpenCV hue is 0-179 = 0-358deg
            attempts["autoDominantColor"] = auto_diag
            if auto_result and (best_result is None or auto_result["confidence"] > best_result["confidence"]):
                best_result = auto_result
                best_source = "autoDominantColor"

    diagnostics = {"frameSize": [w, h], "attempts": attempts, "source": best_source}

    if best_result is None:
        diagnostics["reason"] = "no candidate mask (fixed bands or auto-detected dominant color) produced a usable quadrilateral"
        return {
            "method": "classical-cv-hsv-contour",
            "confidence": 0.0,
            "cornersImagePx": None,
            "diagnostics": diagnostics,
        }

    return {
        "method": "classical-cv-hsv-contour",
        "confidence": round(best_result["confidence"], 3),
        "cornersImagePx": best_result["corners"],
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
