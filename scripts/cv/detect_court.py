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
    in *image* space (y grows downward), where "bottom" is the court edge
    nearest the camera.

    Sorting by y alone (the classic trick) breaks as soon as the camera sits
    off the court's centre line — from a corner, the near baseline runs
    diagonally and one of its endpoints can be higher in the frame than a
    far-edge corner. Instead: walk the quad in polygon order, take the edge
    whose midpoint is lowest in the frame as the near edge, and label the
    other two corners by adjacency.
    """
    pts = np.array(pts, dtype=np.float32)
    centre = pts.mean(axis=0)
    angles = np.arctan2(pts[:, 1] - centre[1], pts[:, 0] - centre[0])
    order = np.argsort(angles)  # counter-clockwise in image coords
    p = pts[order]
    edges = [(i, (i + 1) % 4) for i in range(4)]
    # The edge nearest the camera is the longest one in the image — true
    # even from a corner, where "lowest midpoint" would pick a sideline.
    near = max(edges, key=lambda e: float(np.hypot(*(p[e[0]] - p[e[1]]))))
    i0, i1 = near
    a, b = p[i0], p[i1]
    if a[0] <= b[0]:
        bottom_left, bottom_right, bl_idx = a, b, i0
    else:
        bottom_left, bottom_right, bl_idx = b, a, i1
    # Walk the polygon from bottomLeft away from bottomRight: the next
    # vertex is topLeft, the one after that topRight.
    br_idx = i1 if bl_idx == i0 else i0
    step = -1 if (bl_idx + 1) % 4 == br_idx else 1
    top_left = p[(bl_idx + step) % 4]
    top_right = p[(bl_idx + 2 * step) % 4]
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

    if area_frac < 0.03 or solidity < 0.7:
        diagnostics["reason"] = "contour too small or not solid enough to trust"
        return None, diagnostics

    corners = order_corners(approx.reshape(-1, 2).tolist())

    # A court seen from behind its baseline is a trapezoid whose top edge is
    # shorter than its bottom edge. A fit that isn't is not a court.
    top_w = float(np.hypot(corners["topRight"][0] - corners["topLeft"][0], corners["topRight"][1] - corners["topLeft"][1]))
    bottom_w = float(np.hypot(corners["bottomRight"][0] - corners["bottomLeft"][0], corners["bottomRight"][1] - corners["bottomLeft"][1]))
    if bottom_w <= 0 or top_w / bottom_w > 1.0 or top_w / bottom_w < 0.15:
        diagnostics["reason"] = f"not a baseline-view trapezoid (top/bottom width ratio {top_w / max(bottom_w, 1):.2f})"
        return None, diagnostics

    eps_score = 1.0 - (used_eps - 0.015) / (0.04 - 0.015)
    area_score = min(1.0, area_frac / 0.15)
    confidence = float(np.clip(0.45 * solidity + 0.35 * area_score + 0.20 * eps_score, 0.0, 1.0))
    if corner_method == "minAreaRect":
        confidence *= 0.5  # a rotated bounding box is a rough stand-in, never a measured court

    diagnostics["confidence"] = round(confidence, 3)
    return {"corners": corners, "confidence": confidence}, diagnostics


def largest_component_reaching_lowest(mask, w, h, min_area_frac=0.02):
    """Connected component (after cleanup) that reaches furthest down the
    frame — the court being played on, for a camera behind the near
    baseline. Returns (component_mask, contour) or (None, None)."""
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates = [c for c in contours if cv2.contourArea(c) >= min_area_frac * w * h]
    if not candidates:
        return None, None

    def bottom_extent(contour):
        _, y, _, ch = cv2.boundingRect(contour)
        return y + ch

    c = max(candidates, key=bottom_extent)
    comp = np.zeros((h, w), np.uint8)
    cv2.drawContours(comp, [c], -1, 255, thickness=cv2.FILLED)
    return comp, c


def detect_with_masks(in_play_mask, kitchen_mask, roi, w, h):
    """Court quad from an in-play-surface mask plus (optionally) a
    differently-colored kitchen mask.

    The old approach OR-ed the two masks before looking for a shape, which
    let anything kitchen-colored anywhere in the frame (warm ceiling lights,
    wood, skin) merge into the court blob. Here the in-play surface is found
    FIRST, and kitchen pixels count only where they touch it. The quad is
    then fitted to the in-play component alone, which is the cleanest
    trapezoid in the frame, and the kitchen/other-half evidence is reported
    as `quadKind` so the caller knows which physical rectangle the quad is:
      near-inplay  two-tone court: baseline -> kitchen line (20 x 15 ft)
      near-half    single-tone court split by the net: baseline -> net (20 x 22 ft)
      full         single blob with nothing above it: baseline -> far baseline (20 x 44 ft)
    """
    in_play = cv2.bitwise_and(in_play_mask, roi)
    comp, contour = largest_component_reaching_lowest(in_play, w, h)
    if comp is None:
        return None, {"reason": "no in-play surface component cleared the minimum area"}

    result, diag = quad_from_contour(contour, w, h)
    if result is None:
        return None, diag

    # Kitchen strip: kitchen-colored pixels touching the in-play component.
    ring = cv2.dilate(comp, np.ones((25, 25), np.uint8))
    ring = cv2.bitwise_and(ring, cv2.bitwise_not(comp))
    kitchen_touching = cv2.bitwise_and(cv2.bitwise_and(kitchen_mask, roi), ring)
    # grow that seed into the full connected kitchen region
    kitchen_full = cv2.bitwise_and(kitchen_mask, roi)
    kitchen_full = cv2.morphologyEx(kitchen_full, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    n, labels = cv2.connectedComponents(kitchen_full)
    seed_labels = set(np.unique(labels[kitchen_touching > 0])) - {0}
    kitchen_region = np.isin(labels, list(seed_labels)).astype(np.uint8) * 255 if seed_labels else np.zeros((h, w), np.uint8)
    kitchen_area_frac = float((kitchen_region > 0).sum()) / float((comp > 0).sum())

    # Another same-color component directly above (the far half across the net)?
    top_y = int(min(p[1] for p in result["corners"].values()))
    band = np.zeros((h, w), np.uint8)
    band[max(0, top_y - 40):max(0, top_y - 4), :] = 255
    above = cv2.bitwise_and(cv2.bitwise_and(in_play_mask, band), cv2.bitwise_not(comp))
    above_frac = float((above > 0).sum()) / max(1.0, float((band > 0).sum()))

    if kitchen_area_frac > 0.12:
        kind = "near-inplay"
    elif above_frac > 0.15:
        kind = "near-half"
    else:
        kind = "full"

    diag.update({
        "kitchenAreaFraction": round(kitchen_area_frac, 3),
        "sameColorAboveFraction": round(above_frac, 3),
        "quadKind": kind,
    })
    result["quadKind"] = kind
    return result, diag


def detect(image_path: str) -> dict:
    img = cv2.imread(image_path)
    if img is None:
        return {
            "method": "classical-cv-hsv-contour",
            "confidence": 0.0,
            "cornersImagePx": None,
            "quadKind": None,
            "diagnostics": {"error": f"could not read image: {image_path}"},
        }

    h, w = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    # A fixed camera behind the baseline never has court surface in the top
    # ~30% of the frame — that is wall, ceiling and lighting, which is
    # exactly where warm "kitchen-colored" false positives live.
    roi = np.zeros((h, w), np.uint8)
    roi[int(h * 0.30):, :] = 255

    attempts = {}
    in_play_fixed = cv2.inRange(hsv, (35, 40, 40), (95, 255, 255))
    kitchen_fixed = cv2.inRange(hsv, (0, 60, 60), (25, 255, 255))

    fixed_result, fixed_diag = detect_with_masks(in_play_fixed, kitchen_fixed, roi, w, h)
    attempts["fixedBands"] = fixed_diag
    best_result, best_source = fixed_result, ("fixedBands" if fixed_result else None)

    if best_result is None or best_result["confidence"] < 0.5:
        auto_mask, peak_hue = auto_dominant_mask(hsv, roi)
        if auto_mask is not None:
            # With an auto-detected in-play hue, "kitchen" is any saturated
            # region of a clearly different hue touching it.
            other = cv2.bitwise_and(cv2.inRange(hsv, (0, 60, 50), (179, 255, 255)), cv2.bitwise_not(auto_mask))
            auto_result, auto_diag = detect_with_masks(auto_mask, other, roi, w, h)
            auto_diag["peakHueDegrees"] = round(peak_hue * 2, 1)
            attempts["autoDominantColor"] = auto_diag
            if auto_result and (best_result is None or auto_result["confidence"] > best_result["confidence"]):
                best_result, best_source = auto_result, "autoDominantColor"

    diagnostics = {"frameSize": [w, h], "attempts": attempts, "source": best_source}
    if best_result is None:
        diagnostics["reason"] = "no candidate mask produced a usable quadrilateral"
        return {"method": "classical-cv-hsv-contour", "confidence": 0.0, "cornersImagePx": None, "quadKind": None, "diagnostics": diagnostics}

    return {
        "method": "classical-cv-hsv-contour",
        "confidence": round(best_result["confidence"], 3),
        "cornersImagePx": best_result["corners"],
        "quadKind": best_result.get("quadKind"),
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
