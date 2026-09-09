"""Player tracking: constant-velocity Kalman boxes, ByteTrack-style association.

Two-stage matching is the whole point.  A player who turns sideways or is
half-occluded by their partner drops to a low detection score for a few frames;
matching high-score detections first and then offering the *unmatched tracks*
the low-score leftovers keeps that player's identity instead of ending the track
and starting a new one.  Identity churn would show up downstream as a spurious
activity spike, which is exactly the kind of thing that splits a rally.
"""

from __future__ import annotations

from typing import List, Sequence, Tuple

import numpy as np

from ..config import TrackerConfig
from ..detect.players import BoxDetection

try:
    from scipy.optimize import linear_sum_assignment  # type: ignore
    _HAS_SCIPY = True
except ImportError:  # pragma: no cover
    _HAS_SCIPY = False


def iou_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    if len(a) == 0 or len(b) == 0:
        return np.zeros((len(a), len(b)), dtype=np.float32)
    ax1, ay1, ax2, ay2 = a[:, 0:1], a[:, 1:2], a[:, 2:3], a[:, 3:4]
    bx1, by1, bx2, by2 = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
    inter_w = np.clip(np.minimum(ax2, bx2) - np.maximum(ax1, bx1), 0, None)
    inter_h = np.clip(np.minimum(ay2, by2) - np.maximum(ay1, by1), 0, None)
    inter = inter_w * inter_h
    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    return (inter / np.maximum(1e-6, area_a + area_b - inter)).astype(np.float32)


def _assign(cost: np.ndarray) -> List[Tuple[int, int]]:
    if cost.size == 0:
        return []
    if _HAS_SCIPY:
        rows, cols = linear_sum_assignment(cost)
        return list(zip(rows.tolist(), cols.tolist()))
    # Greedy fallback: fine at four players, and keeps scipy optional.
    pairs: List[Tuple[int, int]] = []
    used_r, used_c = set(), set()
    order = np.dstack(np.unravel_index(np.argsort(cost, axis=None), cost.shape))[0]
    for r, c in order:
        r, c = int(r), int(c)
        if r in used_r or c in used_c:
            continue
        pairs.append((r, c))
        used_r.add(r)
        used_c.add(c)
    return pairs


class Track:
    """A tracked player.  State is [cx, cy, w, h, vx, vy]."""

    _next_id = 1

    def __init__(self, det: BoxDetection, cfg: TrackerConfig):
        self.id = Track._next_id
        Track._next_id += 1
        self.cfg = cfg
        cx, cy = det.centre
        self.x = np.array([cx, cy, det.x2 - det.x1, det.y2 - det.y1, 0.0, 0.0], dtype=np.float64)
        self.P = np.diag([10.0, 10.0, 10.0, 10.0, 1e3, 1e3])
        self.hits = 1
        self.age = 0
        self.time_since_update = 0
        self.conf = det.conf
        self.history: List[np.ndarray] = [self.feet.copy()]

    # --- geometry ---------------------------------------------------------

    @property
    def xyxy(self) -> np.ndarray:
        cx, cy, w, h = self.x[:4]
        return np.array([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], dtype=np.float32)

    @property
    def centre(self) -> np.ndarray:
        return self.x[:2].astype(np.float32)

    @property
    def feet(self) -> np.ndarray:
        cx, cy, _w, h = self.x[:4]
        return np.array([cx, cy + h / 2], dtype=np.float32)

    @property
    def speed_px(self) -> float:
        return float(np.hypot(self.x[4], self.x[5]))

    @property
    def confirmed(self) -> bool:
        return self.hits >= self.cfg.min_hits

    # --- filter -----------------------------------------------------------

    def predict(self) -> None:
        F = np.eye(6)
        F[0, 4] = 1.0
        F[1, 5] = 1.0
        self.x = F @ self.x
        Q = np.diag([4.0, 4.0, 4.0, 4.0, 9.0, 9.0])
        self.P = F @ self.P @ F.T + Q
        self.age += 1
        self.time_since_update += 1
        # A box cannot invert; clamp rather than let the filter drift negative.
        self.x[2] = max(2.0, self.x[2])
        self.x[3] = max(2.0, self.x[3])

    def update(self, det: BoxDetection) -> None:
        z = np.array([*det.centre, det.x2 - det.x1, det.y2 - det.y1], dtype=np.float64)
        H = np.zeros((4, 6))
        H[0, 0] = H[1, 1] = H[2, 2] = H[3, 3] = 1.0
        R = np.diag([6.0, 6.0, 12.0, 12.0])
        y = z - H @ self.x
        S = H @ self.P @ H.T + R
        K = self.P @ H.T @ np.linalg.inv(S)
        self.x = self.x + K @ y
        self.P = (np.eye(6) - K @ H) @ self.P
        self.hits += 1
        self.time_since_update = 0
        self.conf = det.conf
        self.history.append(self.feet.copy())
        if len(self.history) > 120:
            self.history.pop(0)


class PlayerTracker:
    def __init__(self, cfg: TrackerConfig):
        self.cfg = cfg
        self.tracks: List[Track] = []

    def update(self, detections: Sequence[BoxDetection]) -> List[Track]:
        for t in self.tracks:
            t.predict()

        high = [d for d in detections if d.conf >= self.cfg.high_thresh]
        low = [d for d in detections if self.cfg.low_thresh <= d.conf < self.cfg.high_thresh]

        unmatched_tracks = list(range(len(self.tracks)))
        unmatched_tracks = self._match(high, unmatched_tracks)
        unmatched_tracks = self._match(low, unmatched_tracks)

        # Only high-confidence leftovers earn a new track; low-confidence noise
        # spawning tracks is how a flapping shadow becomes a fifth player.
        for det in high:
            if not getattr(det, "_matched", False):
                self.tracks.append(Track(det, self.cfg))
        for det in detections:
            if hasattr(det, "_matched"):
                delattr(det, "_matched")

        self.tracks = [t for t in self.tracks if t.time_since_update <= self.cfg.max_age]
        return [t for t in self.tracks if t.confirmed and t.time_since_update == 0]

    def _match(self, dets: Sequence[BoxDetection], track_idx: List[int]) -> List[int]:
        avail = [i for i in track_idx]
        pending = [d for d in dets if not getattr(d, "_matched", False)]
        if not avail or not pending:
            return avail
        track_boxes = np.array([self.tracks[i].xyxy for i in avail], dtype=np.float32)
        det_boxes = np.array([d.xyxy for d in pending], dtype=np.float32)
        ious = iou_matrix(track_boxes, det_boxes)

        # IoU alone breaks exactly when it matters.  When two players cross,
        # their boxes overlap each other as much as they overlap their own
        # previous position, so IoU stops telling them apart -- and when one
        # walks toward the camera its box changes size fast enough that IoU with
        # its own past drops through the threshold.  Distance between predicted
        # and observed *feet*, normalised by body height, keeps working through
        # both: feet are on the ground plane and people do not teleport.
        feet_t = np.array([[(b[0] + b[2]) / 2, b[3]] for b in track_boxes], dtype=np.float32)
        feet_d = np.array([[(b[0] + b[2]) / 2, b[3]] for b in det_boxes], dtype=np.float32)
        heights = np.array([max(24.0, self.tracks[i].x[3]) for i in avail], dtype=np.float32)
        dist = np.linalg.norm(feet_t[:, None, :] - feet_d[None, :, :], axis=2)
        proximity = np.clip(1.0 - dist / (heights[:, None] * self.cfg.match_distance_heights), 0.0, 1.0)

        affinity = np.maximum(ious, proximity * self.cfg.proximity_weight)
        pairs = _assign(1.0 - affinity)
        still_unmatched = set(avail)
        for r, c in pairs:
            if affinity[r, c] < self.cfg.match_iou:
                continue
            self.tracks[avail[r]].update(pending[c])
            setattr(pending[c], "_matched", True)
            still_unmatched.discard(avail[r])
        return sorted(still_unmatched)

    @property
    def active(self) -> List[Track]:
        return [t for t in self.tracks if t.confirmed and t.time_since_update <= 2]
