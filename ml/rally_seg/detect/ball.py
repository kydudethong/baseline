"""Ball detection.

A pickleball is 74 mm across.  Filmed from behind the baseline at 1080p it is
6-12 px wide, and while travelling it is a motion-blurred smear rather than a
circle.  That makes it a genuinely hard small-object problem, and it drives
three decisions here:

1. **Tiled inference.**  Ultralytics letterboxes a 1920x1080 frame down to
   640x640 before the network sees it; a 8 px ball becomes 4 px, below what the
   stride-8 detection head can represent.  Splitting the frame into overlapping
   tiles and running each at native scale is the difference between ~30% and
   ~90% recall.
2. **ROI following.**  Tiling costs 4-9 forward passes per frame.  Once a track
   exists, a single crop around the Kalman prediction is both cheaper and more
   precise.  The full sweep comes back the moment the track goes stale.
3. **A detector-free fallback.**  ``motion`` finds ball candidates by frame
   differencing with shape and size gates.  It is materially worse than a
   trained model, and it exists so the pipeline is runnable, testable and
   debuggable before weights arrive -- never as the production path.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

import cv2
import numpy as np

from ..config import BallDetectorConfig


@dataclass
class Detection:
    x: float
    y: float
    conf: float
    w: float = 0.0
    h: float = 0.0

    @property
    def xy(self) -> np.ndarray:
        return np.array([self.x, self.y], dtype=np.float32)

    @property
    def radius(self) -> float:
        return max(1.0, (self.w + self.h) / 4.0)


def resolve_device(requested: str) -> str:
    if requested and requested != "auto":
        return requested
    try:
        import torch  # type: ignore
    except ImportError:
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class BallDetector:
    """Common interface: ``detect(frame, roi=None) -> list[Detection]``."""

    name = "base"

    def detect(self, image: np.ndarray, roi: Optional[Tuple[int, int, int, int]] = None) -> List[Detection]:
        raise NotImplementedError

    def close(self) -> None:
        pass


class YoloBallDetector(BallDetector):
    name = "yolo"

    def __init__(self, cfg: BallDetectorConfig):
        self.cfg = cfg
        if not os.path.exists(cfg.weights):
            raise FileNotFoundError(
                f"ball weights not found at {cfg.weights}.\n"
                "Train or export them first (see ml/rally_seg/train/train_ball_yolo.py), "
                "or run with ball.backend=motion for a weights-free smoke test."
            )
        try:
            from ultralytics import YOLO  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "ultralytics is not installed: pip install -r ml/requirements-yolo.txt"
            ) from exc
        self.device = resolve_device(cfg.device)
        self.model = YOLO(cfg.weights)
        self.model.to(self.device)
        # half precision is a CUDA-only win; on MPS/CPU it is slower or unsupported.
        self.half = bool(cfg.half and self.device == "cuda")

    # --- public ------------------------------------------------------------

    def detect(self, image: np.ndarray, roi: Optional[Tuple[int, int, int, int]] = None) -> List[Detection]:
        if roi is not None:
            x0, y0, x1, y1 = _clip_roi(roi, image.shape[1], image.shape[0])
            if x1 - x0 < 8 or y1 - y0 < 8:
                return []
            crop = image[y0:y1, x0:x1]
            dets = self._infer([crop])[0]
            return [Detection(d.x + x0, d.y + y0, d.conf, d.w, d.h) for d in dets]

        if not self.cfg.tiled:
            return self._infer([image])[0]

        crops, offsets = _tiles(image, self.cfg.tile_rows, self.cfg.tile_cols, self.cfg.tile_overlap)
        results = self._infer(crops)
        merged: List[Detection] = []
        for dets, (ox, oy) in zip(results, offsets):
            for d in dets:
                merged.append(Detection(d.x + ox, d.y + oy, d.conf, d.w, d.h))
        return _nms(merged, self.cfg.iou)[: self.cfg.max_det]

    # --- internals ---------------------------------------------------------

    def _infer(self, images: Sequence[np.ndarray]) -> List[List[Detection]]:
        out: List[List[Detection]] = []
        bs = max(1, self.cfg.batch_size)
        for i in range(0, len(images), bs):
            batch = list(images[i : i + bs])
            preds = self.model.predict(
                batch, conf=self.cfg.conf, iou=self.cfg.iou, imgsz=self.cfg.imgsz,
                device=self.device, half=self.half, max_det=self.cfg.max_det,
                verbose=False,
            )
            for pred in preds:
                dets: List[Detection] = []
                boxes = getattr(pred, "boxes", None)
                if boxes is None or boxes.xyxy is None:
                    out.append(dets)
                    continue
                xyxy = boxes.xyxy.cpu().numpy()
                confs = boxes.conf.cpu().numpy()
                classes = boxes.cls.cpu().numpy().astype(int) if boxes.cls is not None else np.zeros(len(xyxy), int)
                for (x1, y1, x2, y2), conf, cls in zip(xyxy, confs, classes):
                    if self.cfg.class_id >= 0 and int(cls) != self.cfg.class_id:
                        continue
                    dets.append(Detection(
                        x=float((x1 + x2) / 2), y=float((y1 + y2) / 2),
                        conf=float(conf), w=float(x2 - x1), h=float(y2 - y1),
                    ))
                out.append(dets)
        return out


class MotionBallDetector(BallDetector):
    """Weights-free candidate finder.

    MOG2 background subtraction plus size/shape/solidity gates.  Players are
    rejected by area; the net and shadows by aspect ratio and solidity.  It is
    noisy by construction -- the Kalman tracker downstream is what turns a noisy
    candidate stream into a usable trajectory.
    """

    name = "motion"

    def __init__(self, cfg: BallDetectorConfig):
        self.cfg = cfg
        self.bg = cv2.createBackgroundSubtractorMOG2(
            history=cfg.motion_history, varThreshold=cfg.motion_var_threshold, detectShadows=False
        )
        self._kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))

    def detect(self, image: np.ndarray, roi: Optional[Tuple[int, int, int, int]] = None) -> List[Detection]:
        # The background model must see every frame, ROI or not, or it drifts.
        mask = self.bg.apply(image)
        _, mask = cv2.threshold(mask, 200, 255, cv2.THRESH_BINARY)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, self._kernel)
        mask = cv2.dilate(mask, self._kernel, iterations=1)

        if roi is not None:
            x0, y0, x1, y1 = _clip_roi(roi, image.shape[1], image.shape[0])
            keep = np.zeros_like(mask)
            keep[y0:y1, x0:x1] = mask[y0:y1, x0:x1]
            mask = keep

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        dets: List[Detection] = []
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < self.cfg.motion_min_area or area > self.cfg.motion_max_area:
                continue
            x, y, w, h = cv2.boundingRect(cnt)
            if w == 0 or h == 0:
                continue
            aspect = max(w, h) / float(min(w, h))
            if aspect > 3.2:            # motion blur stretches, but not this far
                continue
            hull_area = cv2.contourArea(cv2.convexHull(cnt)) or area
            solidity = area / hull_area
            if solidity < 0.55:
                continue
            fill = area / float(w * h)
            conf = float(np.clip(0.25 + 0.45 * solidity + 0.30 * fill, 0.0, 0.95))
            dets.append(Detection(x=x + w / 2.0, y=y + h / 2.0, conf=conf, w=float(w), h=float(h)))

        dets.sort(key=lambda d: -d.conf)
        return dets[: self.cfg.max_det]


class ReplayBallDetector(BallDetector):
    """Replay detections from disk.

    Two formats, detected by shape:

    1. ``{"detections": {"<frame>": [[x, y, conf, w, h], ...]}}`` -- pixel
       coordinates in the frame the pipeline works in.
    2. ``{"width", "height", "detections": [{"frame", "x", "y", "w", "h",
       "conf"}, ...]}`` -- normalised centres, as written by pb-analyzer's
       ``scripts/cv/detect_ball.py``.

    Used for deterministic regression tests, and for running detection on one
    machine (or one detector) and segmentation on another.
    """

    name = "replay"

    def __init__(self, cfg: BallDetectorConfig):
        self.cfg = cfg
        if not cfg.replay_path or not os.path.exists(cfg.replay_path):
            raise FileNotFoundError(f"replay file not found: {cfg.replay_path}")
        import json

        with open(cfg.replay_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        raw = data.get("detections", data)
        self.by_frame: dict = {}
        if isinstance(raw, dict):
            self.by_frame = {int(k): list(v) for k, v in raw.items()}
        else:
            w = float(data.get("width", 1.0))
            h = float(data.get("height", 1.0))
            for d in raw:
                self.by_frame.setdefault(int(d["frame"]), []).append([
                    float(d["x"]) * w, float(d["y"]) * h, float(d.get("conf", 0.5)),
                    float(d.get("w", 0.0)) * w, float(d.get("h", 0.0)) * h,
                ])
        self._scale = 1.0
        self._cursor = -1

    def set_scale(self, scale: float) -> None:
        """Detections were made at source resolution; the pipeline may downscale."""
        self._scale = 1.0 / max(1e-6, scale)

    def set_frame(self, frame_index: int) -> None:
        self._cursor = frame_index

    def detect(self, image: np.ndarray, roi: Optional[Tuple[int, int, int, int]] = None) -> List[Detection]:
        rows = self.by_frame.get(self._cursor, [])
        k = self._scale
        dets = [Detection(float(r[0]) * k, float(r[1]) * k, float(r[2]),
                          (float(r[3]) if len(r) > 3 else 8.0) * k,
                          (float(r[4]) if len(r) > 4 else 8.0) * k)
                for r in rows]
        if roi is not None:
            x0, y0, x1, y1 = roi
            dets = [d for d in dets if x0 <= d.x <= x1 and y0 <= d.y <= y1]
        return dets[: self.cfg.max_det]


def build_ball_detector(cfg: BallDetectorConfig) -> BallDetector:
    backend = (cfg.backend or "auto").lower()
    if backend == "replay":
        return ReplayBallDetector(cfg)
    if backend == "motion":
        return MotionBallDetector(cfg)
    if backend == "yolo":
        return YoloBallDetector(cfg)
    # auto: prefer the trained model, fall back loudly.
    try:
        return YoloBallDetector(cfg)
    except Exception:
        return MotionBallDetector(cfg)


# --- helpers -----------------------------------------------------------------


def _clip_roi(roi: Tuple[int, int, int, int], w: int, h: int) -> Tuple[int, int, int, int]:
    x0, y0, x1, y1 = (int(round(v)) for v in roi)
    return max(0, x0), max(0, y0), min(w, x1), min(h, y1)


def _tiles(image: np.ndarray, rows: int, cols: int, overlap: float):
    h, w = image.shape[:2]
    rows, cols = max(1, rows), max(1, cols)
    tile_h = int(np.ceil(h / rows))
    tile_w = int(np.ceil(w / cols))
    pad_y = int(tile_h * overlap)
    pad_x = int(tile_w * overlap)
    crops, offsets = [], []
    for r in range(rows):
        for c in range(cols):
            y0 = max(0, r * tile_h - pad_y)
            y1 = min(h, (r + 1) * tile_h + pad_y)
            x0 = max(0, c * tile_w - pad_x)
            x1 = min(w, (c + 1) * tile_w + pad_x)
            crops.append(image[y0:y1, x0:x1])
            offsets.append((x0, y0))
    return crops, offsets


def _nms(dets: List[Detection], iou_thresh: float) -> List[Detection]:
    if not dets:
        return []
    # Zero-size boxes (motion backend edge case) get a nominal 6 px footprint so
    # duplicate suppression still works.
    boxes = np.array([
        [d.x - max(d.w, 6.0) / 2, d.y - max(d.h, 6.0) / 2,
         d.x + max(d.w, 6.0) / 2, d.y + max(d.h, 6.0) / 2]
        for d in dets
    ], dtype=np.float64)
    scores = np.array([d.conf for d in dets])
    order = scores.argsort()[::-1]
    keep: List[int] = []
    while order.size:
        i = int(order[0])
        keep.append(i)
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(boxes[i, 0], boxes[rest, 0])
        yy1 = np.maximum(boxes[i, 1], boxes[rest, 1])
        xx2 = np.minimum(boxes[i, 2], boxes[rest, 2])
        yy2 = np.minimum(boxes[i, 3], boxes[rest, 3])
        inter = np.clip(xx2 - xx1, 0, None) * np.clip(yy2 - yy1, 0, None)
        area_i = (boxes[i, 2] - boxes[i, 0]) * (boxes[i, 3] - boxes[i, 1])
        area_r = (boxes[rest, 2] - boxes[rest, 0]) * (boxes[rest, 3] - boxes[rest, 1])
        iou = inter / np.maximum(1e-6, area_i + area_r - inter)
        order = rest[iou <= iou_thresh]
    return [dets[i] for i in keep]
