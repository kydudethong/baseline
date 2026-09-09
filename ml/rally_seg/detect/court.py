"""Court detection and homography.

Why this matters more than it looks: with a homography from image pixels to
court feet, a *bounce* becomes a real court coordinate.  The ball is genuinely
on the ground plane at the instant it bounces, so the planar mapping is exact
there -- no depth estimate, no camera calibration.  That single fact turns
"out of bounds" from a guess into a measurement, and it is the backbone of the
rally-end logic.

Two backends:

``classical``  white-line mask -> Hough segments -> outer quad -> homography,
               scored by how much white the *other* court lines land on.
``keypoint``   a heatmap model predicting named court points; loaded from a
               torch checkpoint when one exists.  Same output type, so the rest
               of the pipeline cannot tell the difference.
"""

from __future__ import annotations

import itertools
import json
import math
import os
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

from ..config import CourtConfig

# --- canonical court, in feet ------------------------------------------------
COURT_W = 20.0          # sideline to sideline
COURT_L = 44.0          # baseline to baseline
NET_Y = COURT_L / 2.0   # 22
KITCHEN_DEPTH = 7.0     # non-volley zone, each side of the net
KITCHEN_NEAR_Y = NET_Y - KITCHEN_DEPTH   # 15
KITCHEN_FAR_Y = NET_Y + KITCHEN_DEPTH    # 29
NET_HEIGHT_CENTER_FT = 34.0 / 12.0
NET_HEIGHT_POST_FT = 36.0 / 12.0

#: Outer corners, clockwise from near-left as the camera sees a court filmed
#: from behind one baseline.
COURT_CORNERS = np.array(
    [[0.0, 0.0], [COURT_W, 0.0], [COURT_W, COURT_L], [0.0, COURT_L]], dtype=np.float32
)

#: Reference lines used to *score* a candidate homography.  These are the lines
#: a correct fit explains and a wrong one does not.
#: Note what is *not* here: the net.  The net line on the ground is the one
#: court marking that is never visible, because the net stands on top of it.
#: Scoring it as a positive reference guarantees a fifth of the samples miss on
#: a perfect fit, and biases the search toward quads that put something white
#: where the net line should be -- which is exactly the wrong answer.
REFERENCE_LINES: List[Tuple[Tuple[float, float], Tuple[float, float]]] = [
    ((0.0, KITCHEN_NEAR_Y), (COURT_W, KITCHEN_NEAR_Y)),     # near kitchen line
    ((0.0, KITCHEN_FAR_Y), (COURT_W, KITCHEN_FAR_Y)),       # far kitchen line
    ((COURT_W / 2, 0.0), (COURT_W / 2, KITCHEN_NEAR_Y)),    # near centre line
    ((COURT_W / 2, KITCHEN_FAR_Y), (COURT_W / 2, COURT_L)), # far centre line
]

#: Regions that must be *blank* court surface if the fit is right: the middle of
#: each service box and each kitchen half.
#:
#: Rewarding only "lines land on white" is not enough on its own.  A homography
#: that squeezes the whole 44 ft court onto the near half puts its far baseline
#: on the net tape and its kitchen lines on real paint, and scores well while
#: being completely wrong -- which is exactly the failure this catches.  A wrong
#: fit puts these blank samples on real lines; a right one does not.
#: Placement matters as much as the idea.  These sit in the middle of the four
#: service boxes -- the only sizeable stretches of court with no paint on them,
#: and comfortably clear of the sidelines, the centre line, the kitchen lines
#: and the net.  Sampling the kitchen instead, as an earlier version did, puts
#: points against the net where the mesh reads as white in the mask, so even a
#: perfect fit looked wrong.
NEGATIVE_REGIONS: List[Tuple[float, float]] = [
    (COURT_W * 0.25, 5.0), (COURT_W * 0.75, 5.0),           # near service boxes
    (COURT_W * 0.25, 11.0), (COURT_W * 0.75, 11.0),
    (COURT_W * 0.25, 33.0), (COURT_W * 0.75, 33.0),         # far service boxes
    (COURT_W * 0.25, 39.0), (COURT_W * 0.75, 39.0),
]

#: The near half only: baseline to net.  A camera on a low tripod behind the
#: baseline cannot see the far half at all -- the net occludes it -- so a
#: full-court fit is not merely inaccurate there, it is unobtainable.  Fitting
#: what is actually visible gives real coordinates for the near half instead of
#: fabricated ones for the whole court.
HALF_CORNERS = np.array(
    [[0.0, 0.0], [COURT_W, 0.0], [COURT_W, NET_Y], [0.0, NET_Y]], dtype=np.float32
)

HALF_REFERENCE_LINES: List[Tuple[Tuple[float, float], Tuple[float, float]]] = [
    ((0.0, KITCHEN_NEAR_Y), (COURT_W, KITCHEN_NEAR_Y)),     # kitchen line
    ((COURT_W / 2, 0.0), (COURT_W / 2, KITCHEN_NEAR_Y)),    # centre line
]

HALF_NEGATIVE_REGIONS: List[Tuple[float, float]] = [
    (COURT_W * 0.25, 4.0), (COURT_W * 0.75, 4.0),
    (COURT_W * 0.25, 8.0), (COURT_W * 0.75, 8.0),
    (COURT_W * 0.25, 12.0), (COURT_W * 0.75, 12.0),
]


@dataclass
class CourtModel:
    """A fitted court.  All conversions go through here."""

    H: np.ndarray                 # court(ft) -> image(px)
    H_inv: np.ndarray             # image(px) -> court(ft)
    confidence: float
    image_size: Tuple[int, int]   # (w, h)
    corners_px: np.ndarray        # 4x2, the fitted outer quad
    source: str = "classical"
    #: "full" or "near_half".  Court coordinates beyond ``observable_max_y`` are
    #: extrapolation, not measurement, and callers must not treat them as real.
    extent: str = "full"
    #: Fraction of successfully fitted sample frames that agreed with this fit.
    #: Low agreement means the camera moved, or the court is barely visible, and
    #: the geometry should not be trusted.
    agreement: float = 1.0

    # --- conversions ------------------------------------------------------

    def to_image(self, pts_ft: np.ndarray) -> np.ndarray:
        pts = np.asarray(pts_ft, dtype=np.float32).reshape(-1, 1, 2)
        return cv2.perspectiveTransform(pts, self.H).reshape(-1, 2)

    def to_court(self, pts_px: np.ndarray) -> np.ndarray:
        pts = np.asarray(pts_px, dtype=np.float32).reshape(-1, 1, 2)
        return cv2.perspectiveTransform(pts, self.H_inv).reshape(-1, 2)

    @property
    def observable_max_y(self) -> float:
        """Furthest court depth this fit actually saw, in feet."""
        return COURT_L if self.extent == "full" else NET_Y

    def is_observable(self, pt_ft: Sequence[float]) -> bool:
        return -3.0 <= float(pt_ft[1]) <= self.observable_max_y + 3.0

    # --- derived geometry -------------------------------------------------

    @property
    def net_line_px(self) -> Tuple[np.ndarray, np.ndarray]:
        pts = self.to_image(np.array([[0.0, NET_Y], [COURT_W, NET_Y]]))
        return pts[0], pts[1]

    @property
    def bounds_polygon_px(self) -> np.ndarray:
        return self.to_image(COURT_CORNERS)

    def px_per_ft_at(self, pt_ft: Sequence[float]) -> float:
        """Local scale, so pixel thresholds can be written in feet."""
        x, y = float(pt_ft[0]), float(pt_ft[1])
        a = self.to_image(np.array([[x, y]]))[0]
        b = self.to_image(np.array([[min(x + 1.0, COURT_W), y]]))[0]
        c = self.to_image(np.array([[x, min(y + 1.0, COURT_L)]]))[0]
        return float((np.linalg.norm(b - a) + np.linalg.norm(c - a)) / 2.0) or 1.0

    def side_of_net(self, pt_ft: Sequence[float]) -> int:
        """-1 near side, +1 far side."""
        return -1 if float(pt_ft[1]) < NET_Y else 1

    def is_in_bounds(self, pt_ft: Sequence[float], margin_ft: float = 0.0) -> bool:
        x, y = float(pt_ft[0]), float(pt_ft[1])
        return (-margin_ft <= x <= COURT_W + margin_ft) and (-margin_ft <= y <= COURT_L + margin_ft)

    def net_band_px(self, x_px: float) -> Tuple[float, float]:
        """Image-y range occupied by the net tape at a given image x.

        Approximate -- the homography is planar and the net is not -- but good
        enough to ask "did the ball die at the net", which is a question about a
        band a couple of feet tall.
        """
        p0, p1 = self.net_line_px
        if abs(p1[0] - p0[0]) < 1e-6:
            y_net = (p0[1] + p1[1]) / 2.0
        else:
            t = np.clip((x_px - p0[0]) / (p1[0] - p0[0]), 0.0, 1.0)
            y_net = float(p0[1] + t * (p1[1] - p0[1]))
        scale = self.px_per_ft_at((COURT_W / 2, NET_Y))
        top = y_net - NET_HEIGHT_POST_FT * scale
        return top, y_net

    def to_dict(self) -> dict:
        return {
            "H": self.H.tolist(),
            "confidence": self.confidence,
            "image_size": list(self.image_size),
            "corners_px": self.corners_px.tolist(),
            "source": self.source,
            "extent": self.extent,
            "agreement": self.agreement,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "CourtModel":
        H = np.array(d["H"], dtype=np.float64)
        return cls(
            H=H, H_inv=np.linalg.inv(H), confidence=float(d.get("confidence", 0.0)),
            image_size=tuple(d.get("image_size", (0, 0))),
            corners_px=np.array(d.get("corners_px", []), dtype=np.float32),
            source=d.get("source", "unknown"),
            extent=d.get("extent", "full"),
            agreement=float(d.get("agreement", 1.0)),
        )

    @classmethod
    def from_corners(cls, corners_px: np.ndarray, image_size: Tuple[int, int],
                     confidence: float = 1.0, source: str = "manual",
                     extent: str = "full") -> "CourtModel":
        src = EXTENTS[extent][0].astype(np.float32)
        dst = np.asarray(corners_px, dtype=np.float32).reshape(4, 2)
        H = cv2.getPerspectiveTransform(src, dst)
        return cls(H=H, H_inv=np.linalg.inv(H), confidence=confidence,
                   image_size=image_size, corners_px=dst, source=source, extent=extent)


class FallbackCourt:
    """Stand-in when no court can be fitted.

    Not a court -- it exposes only a horizontal net line at a configured height
    fraction, which is enough to keep net-crossing counts alive.  Everything
    that needs real geometry (out-of-bounds, court coordinates, speeds in m/s)
    reports unavailable rather than guessing.
    """

    confidence = 0.0
    source = "fallback"

    def __init__(self, image_size: Tuple[int, int], net_y_frac: float):
        self.image_size = image_size
        self.net_y = image_size[1] * net_y_frac

    @property
    def net_line_px(self) -> Tuple[np.ndarray, np.ndarray]:
        w = self.image_size[0]
        return np.array([0.0, self.net_y]), np.array([w, self.net_y])

    def net_band_px(self, x_px: float) -> Tuple[float, float]:
        h = self.image_size[1]
        return self.net_y - 0.035 * h, self.net_y

    def to_court(self, pts_px: np.ndarray) -> np.ndarray:
        return np.full((np.asarray(pts_px).reshape(-1, 2).shape[0], 2), np.nan, dtype=np.float32)

    def to_image(self, pts_ft: np.ndarray) -> np.ndarray:
        return np.full((np.asarray(pts_ft).reshape(-1, 2).shape[0], 2), np.nan, dtype=np.float32)

    def px_per_ft_at(self, pt_ft) -> float:
        return float("nan")

    def is_in_bounds(self, pt_ft, margin_ft: float = 0.0) -> bool:
        return True

    def side_of_net(self, pt_ft) -> int:
        return 0

    def to_dict(self) -> dict:
        return {"source": "fallback", "net_y": self.net_y, "image_size": list(self.image_size)}


# --- fitting -----------------------------------------------------------------


def white_line_mask(image: np.ndarray, cfg: CourtConfig) -> np.ndarray:
    """Court lines are bright and unsaturated; the court surface is neither."""
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    v = hsv[:, :, 2]
    s = hsv[:, :, 1]
    mask = ((v >= cfg.white_threshold) & (s <= 90)).astype(np.uint8) * 255
    # A painted line is thin: a top-hat keeps lines and discards bright regions
    # like a sunlit fence or a white shirt.
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
    tophat = cv2.morphologyEx(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY),
                              cv2.MORPH_TOPHAT, kernel)
    _, thin = cv2.threshold(tophat, 18, 255, cv2.THRESH_BINARY)
    return cv2.bitwise_and(mask, thin)


def _segments(mask: np.ndarray, cfg: CourtConfig) -> np.ndarray:
    h, w = mask.shape[:2]
    edges = cv2.Canny(mask, cfg.canny_low, cfg.canny_high, apertureSize=3)
    min_len = int(cfg.hough_min_line_frac * max(h, w))
    lines = cv2.HoughLinesP(edges, 1, np.pi / 360, cfg.hough_threshold,
                            minLineLength=max(20, min_len), maxLineGap=cfg.hough_max_gap)
    if lines is None:
        return np.zeros((0, 4), dtype=np.float32)
    return lines.reshape(-1, 4).astype(np.float32)


def _line_from_segment(seg: np.ndarray) -> np.ndarray:
    """Homogeneous line through the segment endpoints."""
    p1 = np.array([seg[0], seg[1], 1.0])
    p2 = np.array([seg[2], seg[3], 1.0])
    return np.cross(p1, p2)


def _intersect(l1: np.ndarray, l2: np.ndarray) -> Optional[np.ndarray]:
    p = np.cross(l1, l2)
    if abs(p[2]) < 1e-9:
        return None
    return np.array([p[0] / p[2], p[1] / p[2]], dtype=np.float32)


def _cluster_lines(segs: np.ndarray, min_length: float = 0.0) -> List[np.ndarray]:
    """Group collinear segments into one line each, regardless of orientation.

    Clustering happens in Hough space -- angle and perpendicular offset -- not
    by binning into "horizontal" and "vertical" families.  The family split was
    the original design and it is wrong: how steep a sideline looks depends
    entirely on where the camera is standing.  Filmed from a low tripod behind
    the baseline the sidelines sit around 23 degrees, which any sensible
    horizontal/vertical threshold reads as horizontal -- leaving no vertical
    lines at all and no court to find.

    Returns ``[a, b, c, support]`` per cluster, where ``ax + by + c = 0``.
    """
    entries = []
    for seg in segs:
        dx, dy = seg[2] - seg[0], seg[3] - seg[1]
        length = math.hypot(dx, dy)
        if length < max(1e-3, min_length):
            continue
        theta = math.atan2(dy, dx) % math.pi          # 0..pi, direction-agnostic
        nx, ny = -math.sin(theta), math.cos(theta)     # unit normal
        rho = nx * seg[0] + ny * seg[1]
        entries.append((theta, rho, seg, length))

    clusters: List[List[tuple]] = []
    theta_tol = math.radians(4.0)
    rho_tol = 12.0
    for item in sorted(entries, key=lambda e: (e[0], e[1])):
        placed = False
        for cluster in clusters:
            t0 = float(np.mean([c[0] for c in cluster]))
            r0 = float(np.mean([c[1] for c in cluster]))
            dtheta = abs(item[0] - t0)
            dtheta = min(dtheta, math.pi - dtheta)     # wrap at 0/pi
            if dtheta <= theta_tol and abs(item[1] - r0) <= rho_tol:
                cluster.append(item)
                placed = True
                break
        if not placed:
            clusters.append([item])

    merged: List[np.ndarray] = []
    for cluster in clusters:
        pts = []
        for _t, _r, seg, _l in cluster:
            pts.append([seg[0], seg[1]])
            pts.append([seg[2], seg[3]])
        pts_arr = np.array(pts, dtype=np.float32)
        vx, vy, x0, y0 = cv2.fitLine(pts_arr, cv2.DIST_L2, 0, 0.01, 0.01).ravel()
        p1 = np.array([x0 - vx * 5000, y0 - vy * 5000, 1.0])
        p2 = np.array([x0 + vx * 5000, y0 + vy * 5000, 1.0])
        line = np.cross(p1, p2)
        norm = math.hypot(line[0], line[1]) or 1.0
        line = line / norm
        support = float(sum(c[3] for c in cluster))
        merged.append(np.append(line, support))

    merged.sort(key=lambda l: -l[3])
    return merged


def _reference_samples(lines=None, n_per_line: int = 48) -> np.ndarray:
    """Points along the reference lines, in court feet.  Computed once."""
    pts = []
    for (a, b) in (REFERENCE_LINES if lines is None else lines):
        for t in np.linspace(0.05, 0.95, n_per_line):
            pts.append([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])
    return np.array(pts, dtype=np.float32).reshape(-1, 1, 2)


def _negative_samples(regions=None, spread: float = 1.1, per_region: int = 9) -> np.ndarray:
    """A small patch of points around each blank region, in court feet."""
    pts = []
    offsets = np.linspace(-spread, spread, int(np.sqrt(per_region)))
    for (cx, cy) in (NEGATIVE_REGIONS if regions is None else regions):
        for dx in offsets:
            for dy in offsets:
                pts.append([cx + dx, cy + dy])
    return np.array(pts, dtype=np.float32).reshape(-1, 1, 2)


_REF_PTS = _reference_samples()
_NEG_PTS = _negative_samples()
_HALF_REF_PTS = _reference_samples(HALF_REFERENCE_LINES)
_HALF_NEG_PTS = _negative_samples(HALF_NEGATIVE_REGIONS)

#: (corner template, positive samples, negative samples) per extent.
EXTENTS = {
    "full": (COURT_CORNERS, _REF_PTS, _NEG_PTS),
    "near_half": (HALF_CORNERS, _HALF_REF_PTS, _HALF_NEG_PTS),
}


def _score_homography(H: np.ndarray, support: np.ndarray, cfg: CourtConfig,
                      extent: str = "full") -> float:
    """Fraction of the reference lines that land on white pixels.

    ``support`` is a dilated white-line mask.  This is the part that actually
    decides which candidate quad is the court: any four lines can be
    intersected into a plausible-looking rectangle, but only the true one
    explains where the kitchen lines, the centre lines and the net are.

    Vectorised because the search evaluates hundreds of candidates per frame.
    """
    h, w = support.shape[:2]

    def sample(pts_ft: np.ndarray) -> Optional[np.ndarray]:
        pts = cv2.perspectiveTransform(pts_ft, H).reshape(-1, 2)
        xs = np.rint(pts[:, 0]).astype(np.int32)
        ys = np.rint(pts[:, 1]).astype(np.int32)
        inside = (xs >= 0) & (xs < w) & (ys >= 0) & (ys < h)
        if inside.sum() < 0.5 * len(xs):
            return None
        return support[ys[inside], xs[inside]] > 0

    _corners, ref_pts, neg_pts = EXTENTS[extent]
    positive = sample(ref_pts)
    if positive is None:
        return 0.0
    score = float(positive.mean())

    negative = sample(neg_pts)
    if negative is not None:
        score -= cfg.negative_weight * float(negative.mean())
    return max(0.0, score)


def _plausible_quad(corners: np.ndarray, image_size: Tuple[int, int],
                    min_area_frac: float = 0.06) -> bool:
    w, h = image_size
    poly = corners.astype(np.float32)
    area = abs(cv2.contourArea(poly))
    if area < min_area_frac * w * h:
        return False
    if not cv2.isContourConvex(poly.astype(np.int32)):
        return False
    # Reject wildly degenerate shapes (a court is longer than it is wide on
    # screen only in extreme angles, but no edge should be near zero).
    edges = [np.linalg.norm(poly[(i + 1) % 4] - poly[i]) for i in range(4)]
    return min(edges) > 0.05 * max(w, h)


def fit_court_from_image(image: np.ndarray, cfg: CourtConfig) -> Optional[CourtModel]:
    """Fit the court by searching quads formed from the strongest line clusters.

    Deliberately makes no assumption about which lines are baselines and which
    are sidelines.  Any four lines can be intersected into a plausible-looking
    rectangle; what identifies the real court is that its homography also
    explains where the kitchen lines, the centre lines and the net are.  So the
    search is broad and the *scoring* is what's discriminating -- which is far
    more robust than trying to classify lines by orientation up front, because
    orientation depends entirely on where the camera is standing.
    """
    h, w = image.shape[:2]
    mask = white_line_mask(image, cfg)
    min_len = max(20.0, cfg.hough_min_line_frac * max(h, w))
    segs = _segments(mask, cfg)
    if len(segs) < 4:
        return None

    lines = _cluster_lines(segs, min_length=min_len * 0.5)
    if len(lines) < 4:
        return None
    lines = lines[: cfg.max_candidate_lines]

    support = cv2.dilate(mask, np.ones((5, 5), np.uint8))
    extents = list(EXTENTS) if cfg.extent == "auto" else [cfg.extent]

    # Cache pairwise intersections: the search revisits them constantly.
    n = len(lines)
    inter: Dict[Tuple[int, int], Optional[np.ndarray]] = {}
    for i in range(n):
        for j in range(i + 1, n):
            inter[(i, j)] = _intersect(lines[i][:3], lines[j][:3])

    def cross(i: int, j: int) -> Optional[np.ndarray]:
        return inter[(i, j)] if i < j else inter[(j, i)]

    best: Optional[CourtModel] = None
    best_score = 0.0
    evaluated = 0

    for combo in itertools.combinations(range(n), 4):
        # Three ways to split four lines into two opposing pairs.
        for (a, b), (c, d) in (((combo[0], combo[1]), (combo[2], combo[3])),
                               ((combo[0], combo[2]), (combo[1], combo[3])),
                               ((combo[0], combo[3]), (combo[1], combo[2]))):
            pts = [cross(a, c), cross(a, d), cross(b, d), cross(b, c)]
            if any(p is None for p in pts):
                continue
            quad = np.array(pts, dtype=np.float32)
            if not np.all(np.isfinite(quad)):
                continue
            if (quad[:, 0].min() < -0.6 * w or quad[:, 0].max() > 1.6 * w
                    or quad[:, 1].min() < -0.6 * h or quad[:, 1].max() > 1.6 * h):
                continue
            quad = _order_quad(quad)
            if not _plausible_quad(quad, (w, h), cfg.min_area_frac):
                continue

            # Which pair of opposite edges is the 20 ft width and which the
            # long axis is not knowable from the quad alone, so try both.  And
            # the quad may be the whole court or only the near half, so try
            # both of those too and let the scoring decide.
            # Which pair of opposite edges is the 20 ft baseline is decided by
            # a prior rather than left to the scorer: filmed from behind a
            # baseline, the near baseline is the closest thing to the camera and
            # therefore the longest edge in the image, while the sidelines
            # converge away.  Without this the search happily rotates the court
            # 90 degrees and lays the net down the middle of it.
            rotations = [(quad, 0.0)]
            if cfg.long_edge_prior > 0:
                rolled_alt = np.roll(quad, 1, axis=0).astype(np.float32)
                edge = lambda q, i: float(np.linalg.norm(q[(i + 1) % 4] - q[i]))
                base_len = max(edge(quad, 0), edge(quad, 2))
                side_len = max(edge(quad, 1), edge(quad, 3))
                penalty = cfg.long_edge_prior if base_len < side_len else 0.0
                rotations = [(quad, penalty),
                             (rolled_alt, cfg.long_edge_prior - penalty)]
            else:
                rotations.append((np.roll(quad, 1, axis=0).astype(np.float32), 0.0))

            for rolled, rot_penalty in rotations:
                for extent in extents:
                    corners = EXTENTS[extent][0]
                    try:
                        H = cv2.getPerspectiveTransform(corners, rolled)
                    except cv2.error:
                        continue
                    if not np.all(np.isfinite(H)) or abs(np.linalg.det(H)) < 1e-9:
                        continue
                    evaluated += 1
                    score = _score_homography(H, support, cfg, extent) - rot_penalty
                    # A half fit is a weaker hypothesis -- two reference lines
                    # instead of five -- so it has to win by a margin, or every
                    # court in the world becomes a half court.
                    if extent != "full":
                        score -= cfg.half_court_penalty
                    if score > best_score:
                        best_score = score
                        best = CourtModel(
                            H=H, H_inv=np.linalg.inv(H), confidence=score,
                            image_size=(w, h), corners_px=rolled.copy(),
                            source="classical", extent=extent)

    if best is None or best_score < cfg.min_line_support:
        return None
    return best


def _order_quad(quad: np.ndarray) -> np.ndarray:
    """Order as near-left, near-right, far-right, far-left (image order)."""
    pts = quad.reshape(4, 2).astype(np.float32)
    centre = pts.mean(axis=0)
    angles = np.arctan2(pts[:, 1] - centre[1], pts[:, 0] - centre[0])
    order = np.argsort(angles)
    pts = pts[order]
    # Rotate so the first point is the bottom-left (largest y, then smallest x).
    bottom = np.argsort(-pts[:, 1])[:2]
    start = bottom[np.argmin(pts[bottom, 0])]
    pts = np.roll(pts, -start, axis=0)
    # COURT_CORNERS runs near-left -> near-right -> far-right -> far-left, which
    # is counter-clockwise in image coordinates (y down).
    if _signed_area(pts) > 0:
        pts = pts[[0, 3, 2, 1]]
    return pts.astype(np.float32)


def _signed_area(pts: np.ndarray) -> float:
    x, y = pts[:, 0], pts[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


class CourtDetector:
    """Fits once over sampled frames (static camera) or periodically."""

    def __init__(self, cfg: CourtConfig):
        self.cfg = cfg
        self._model: Optional[CourtModel] = None
        self._kp = None
        #: Why the fit was thrown away, when it was.  Surfaced as a warning.
        self.last_rejection: Optional[str] = None

    @property
    def model(self):
        return self._model

    def fit(self, frames: Sequence[np.ndarray], image_size: Tuple[int, int]):
        backend = self.cfg.backend
        if backend == "none":
            self._model = None
        elif backend == "fixed" or self.cfg.manual_points_path:
            self._model = self._load_manual(image_size)
        elif backend == "keypoint":
            self._model = self._fit_keypoint(frames, image_size)
            if self._model is None:
                self._model = self._fit_classical(frames)
        else:
            self._model = self._fit_classical(frames)

        if self._model is None:
            return FallbackCourt(image_size, self.cfg.fallback_net_y_frac)
        return self._model

    def _fit_classical(self, frames: Sequence[np.ndarray]) -> Optional[CourtModel]:
        """Fit every sample frame, then take the consensus rather than the best.

        Single-frame scoring is unstable: a player standing on a line, a shadow,
        or one lucky alignment can make a wrong quad outscore the right one on
        one frame out of twenty.  Picking the maximum then hands the whole video
        to that one bad frame.  The correct court, by contrast, is the fit that
        keeps *recurring* -- so cluster the candidates by geometry and take the
        median of the largest cluster.
        """
        fits = [m for m in (fit_court_from_image(img, self.cfg) for img in frames)
                if m is not None]
        if not fits:
            return None
        fits.sort(key=lambda m: -m.confidence)
        keep = [m for m in fits if m.confidence >= self.cfg.consensus_score_frac * fits[0].confidence]

        clusters: List[List[CourtModel]] = []
        for m in keep:
            for cluster in clusters:
                ref = cluster[0]
                if ref.extent != m.extent:
                    continue
                spread = float(np.mean(np.linalg.norm(ref.corners_px - m.corners_px, axis=1)))
                if spread <= self.cfg.consensus_tolerance_px:
                    cluster.append(m)
                    break
            else:
                clusters.append([m])

        # Largest cluster wins; ties go to the better-scoring one.
        clusters.sort(key=lambda c: (len(c), max(m.confidence for m in c)), reverse=True)
        winner = clusters[0]
        corners = np.median(np.stack([m.corners_px for m in winner]), axis=0).astype(np.float32)
        confidence = float(np.median([m.confidence for m in winner]))
        model = CourtModel.from_corners(corners, winner[0].image_size, confidence,
                                        source="classical", extent=winner[0].extent)
        model.agreement = len(winner) / float(len(fits))

        # Two ways to pass, because the agreement fraction on its own throws
        # away correct fits.  It is diluted by frames that fitted *something
        # else badly* -- a player standing on the baseline, a shadow across the
        # kitchen -- not by frames that found a different court.  Several
        # independent frames converging on one quad that also explains most of
        # the paint it predicts is real evidence, whatever fraction of the
        # samples it represents.  What the gate must still catch is the single
        # lucky frame, and requiring a minimum number of agreeing frames does
        # that directly.
        agreed = len(winner)
        strong = agreed >= self.cfg.min_consensus_frames and confidence >= self.cfg.strong_support
        if model.agreement < self.cfg.min_agreement and not strong:
            self.last_rejection = (
                f"court fits disagreed across frames ({agreed} of {len(fits)} agreed, "
                f"line support {confidence:.2f}); treating the court as not found. "
                "Set court.manual_points_path to calibrate this camera position once instead."
            )
            return None
        return model

    def _load_manual(self, image_size: Tuple[int, int]) -> Optional[CourtModel]:
        path = self.cfg.manual_points_path
        if not path or not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        pts = np.array(data["corners_px"], dtype=np.float32).reshape(4, 2)
        # Corners were clicked on a frame at its own resolution; the pipeline
        # may be running downscaled, so rescale rather than silently mis-map.
        src_size = data.get("image_size")
        if src_size and tuple(src_size) != tuple(image_size):
            pts = pts * np.array([image_size[0] / float(src_size[0]),
                                  image_size[1] / float(src_size[1])], dtype=np.float32)
        return CourtModel.from_corners(pts, image_size, confidence=1.0, source="manual",
                                       extent=data.get("extent", "full"))

    def _fit_keypoint(self, frames: Sequence[np.ndarray],
                      image_size: Tuple[int, int]) -> Optional[CourtModel]:
        """Optional learned backend.

        Expects a torch checkpoint that maps a resized BGR frame to four outer
        court corners in normalised image coordinates.  Absent or broken, the
        caller silently falls back to the classical fit.
        """
        if not os.path.exists(self.cfg.weights):
            return None
        try:
            import torch  # type: ignore
        except ImportError:
            return None
        try:
            if self._kp is None:
                self._kp = torch.jit.load(self.cfg.weights)
                self._kp.eval()
            best = None
            for image in frames[: min(6, len(frames))]:
                inp = cv2.resize(image, (384, 384)).astype(np.float32) / 255.0
                tensor = torch.from_numpy(inp.transpose(2, 0, 1)[None])
                with torch.no_grad():
                    pred = self._kp(tensor).cpu().numpy().reshape(-1, 2)
                if pred.shape[0] < 4:
                    continue
                pts = pred[:4] * np.array([image_size[0], image_size[1]], dtype=np.float32)
                quad = _order_quad(pts.astype(np.float32))
                if not _plausible_quad(quad, image_size):
                    continue
                model = CourtModel.from_corners(quad, image_size, confidence=0.9, source="keypoint")
                mask = white_line_mask(frames[0], self.cfg)
                model.confidence = _score_homography(model.H, mask, self.cfg)
                if best is None or model.confidence > best.confidence:
                    best = model
            return best
        except Exception:
            return None
