"""Player detection.

Players are the redundancy channel.  When the ball is occluded -- behind a
player, lost against a bright fence, blurred past the detector -- what tells you
the rally is still alive is that four people are still moving hard.  When the
ball is lost *and* everyone has stopped, the rally is over.  That pairing is
what makes the gap tolerance safe.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

import cv2
import numpy as np

from ..config import PlayerDetectorConfig
from .ball import resolve_device


@dataclass
class BoxDetection:
    x1: float
    y1: float
    x2: float
    y2: float
    conf: float

    @property
    def xyxy(self) -> np.ndarray:
        return np.array([self.x1, self.y1, self.x2, self.y2], dtype=np.float32)

    @property
    def centre(self) -> np.ndarray:
        return np.array([(self.x1 + self.x2) / 2, (self.y1 + self.y2) / 2], dtype=np.float32)

    @property
    def feet(self) -> np.ndarray:
        """Bottom-centre: the only point of a person that is on the court plane."""
        return np.array([(self.x1 + self.x2) / 2, self.y2], dtype=np.float32)

    @property
    def height(self) -> float:
        return max(0.0, self.y2 - self.y1)


class PlayerDetector:
    name = "base"

    def detect(self, image: np.ndarray) -> List[BoxDetection]:
        raise NotImplementedError


class YoloPlayerDetector(PlayerDetector):
    name = "yolo"

    def __init__(self, cfg: PlayerDetectorConfig):
        self.cfg = cfg
        try:
            from ultralytics import YOLO  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "ultralytics is not installed: pip install -r ml/requirements-yolo.txt"
            ) from exc
        self.device = resolve_device(cfg.device)
        # Ultralytics downloads yolov8n.pt on first use if it is not a local path.
        self.model = YOLO(cfg.weights)
        self.model.to(self.device)

    def detect(self, image: np.ndarray) -> List[BoxDetection]:
        preds = self.model.predict(
            image, conf=self.cfg.conf, iou=self.cfg.iou, imgsz=self.cfg.imgsz,
            device=self.device, classes=[0], verbose=False,
        )
        out: List[BoxDetection] = []
        min_h = self.cfg.min_box_height_frac * image.shape[0]
        for pred in preds:
            boxes = getattr(pred, "boxes", None)
            if boxes is None or boxes.xyxy is None:
                continue
            xyxy = boxes.xyxy.cpu().numpy()
            confs = boxes.conf.cpu().numpy()
            for (x1, y1, x2, y2), conf in zip(xyxy, confs):
                if (y2 - y1) < min_h:
                    continue
                out.append(BoxDetection(float(x1), float(y1), float(x2), float(y2), float(conf)))
        out.sort(key=lambda b: -b.conf)
        return out[: self.cfg.max_players * 2]   # tracker prunes the rest


class MotionPlayerDetector(PlayerDetector):
    """Weights-free fallback: large moving blobs, gated on size and uprightness."""

    name = "motion"

    def __init__(self, cfg: PlayerDetectorConfig):
        self.cfg = cfg
        self.bg = cv2.createBackgroundSubtractorMOG2(history=300, varThreshold=32, detectShadows=False)
        self._kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))

    def detect(self, image: np.ndarray) -> List[BoxDetection]:
        mask = self.bg.apply(image)
        _, mask = cv2.threshold(mask, 200, 255, cv2.THRESH_BINARY)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, self._kernel, iterations=2)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        h_img = image.shape[0]
        min_h = self.cfg.min_box_height_frac * h_img
        out: List[BoxDetection] = []
        for cnt in contours:
            x, y, w, h = cv2.boundingRect(cnt)
            if h < min_h or w == 0:
                continue
            if h / float(w) < 0.9:      # a standing person is taller than wide
                continue
            area = cv2.contourArea(cnt)
            conf = float(np.clip(area / float(max(1, w * h)), 0.2, 0.9))
            out.append(BoxDetection(float(x), float(y), float(x + w), float(y + h), conf))
        out.sort(key=lambda b: -(b.y2 - b.y1))
        return out[: self.cfg.max_players * 2]


def build_player_detector(cfg: PlayerDetectorConfig) -> PlayerDetector:
    backend = (cfg.backend or "yolo").lower()
    if backend == "motion":
        return MotionPlayerDetector(cfg)
    try:
        return YoloPlayerDetector(cfg)
    except Exception:
        return MotionPlayerDetector(cfg)
