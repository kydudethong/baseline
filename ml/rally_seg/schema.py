"""Versioned output contract.

Everything downstream -- the Next.js app, the eval harness, the training data
exporter -- reads this and only this.  Bump ``SCHEMA_VERSION`` on any breaking
change and keep the reader tolerant of unknown fields.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

SCHEMA_VERSION = "1.0"


class StartReason(str, Enum):
    """Why the segmenter believes a rally began here."""

    SERVE_DETECTED = "serve_detected"
    BALL_MOTION_ONSET = "ball_motion_onset"
    NET_CROSSING = "net_crossing"
    PLAYER_ACTIVITY = "player_activity"
    RECOVERED_FROM_GAP = "recovered_from_gap"
    VIDEO_START = "video_start"
    MODEL = "model"


class EndReason(str, Enum):
    """Why the segmenter believes the rally ended here."""

    OUT_OF_BOUNDS = "out_of_bounds"
    NET_CONTACT = "net_contact"
    BALL_GROUNDED = "ball_grounded"
    OCCLUSION_TIMEOUT = "occlusion_timeout"
    NEXT_SERVE = "next_serve"
    LOW_ACTIVITY = "low_activity"
    VIDEO_END = "video_end"
    MODEL = "model"


@dataclass
class Evidence:
    """A single scored signal that contributed to a boundary decision."""

    name: str
    t_s: float
    score: float
    detail: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "t_s": round(self.t_s, 3),
            "score": round(self.score, 4),
            "detail": self.detail,
        }


@dataclass
class RallySegment:
    idx: int
    #: The measured rally boundary -- first strike to the ball going dead.
    #: This is what the eval harness scores and what a human labeller marks.
    start_s: float
    end_s: float

    #: The same rally with lead/tail padding applied, which is what you cut a
    #: clip on.  Kept separate on purpose: baking the padding into ``start_s``
    #: makes every measurement look half a second wrong, and makes it impossible
    #: to tell a padding change from an accuracy regression.
    clip_start_s: float = 0.0
    clip_end_s: float = 0.0

    start_reason: StartReason = StartReason.BALL_MOTION_ONSET
    end_reason: EndReason = EndReason.LOW_ACTIVITY

    # 0..1.  ``confidence`` is the segment-level number the app should surface;
    # the two boundary numbers are what the calibration harness optimises.
    confidence: float = 0.0
    start_confidence: float = 0.0
    end_confidence: float = 0.0

    # Cheap descriptive stats, all measured -- never inferred by a language model.
    shots: int = 0
    net_crossings: int = 0
    bounces: int = 0
    ball_coverage: float = 0.0      # fraction of frames with a live ball track
    mean_player_activity: float = 0.0
    max_ball_speed_mps: Optional[float] = None

    evidence: List[Evidence] = field(default_factory=list)

    @property
    def duration_s(self) -> float:
        return max(0.0, self.end_s - self.start_s)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "idx": self.idx,
            "start_s": round(self.start_s, 3),
            "end_s": round(self.end_s, 3),
            "duration_s": round(self.duration_s, 3),
            "clip_start_s": round(self.clip_start_s, 3),
            "clip_end_s": round(self.clip_end_s, 3),
            "start_reason": self.start_reason.value,
            "end_reason": self.end_reason.value,
            "confidence": round(self.confidence, 4),
            "start_confidence": round(self.start_confidence, 4),
            "end_confidence": round(self.end_confidence, 4),
            "shots": self.shots,
            "net_crossings": self.net_crossings,
            "bounces": self.bounces,
            "ball_coverage": round(self.ball_coverage, 4),
            "mean_player_activity": round(self.mean_player_activity, 4),
            "max_ball_speed_mps": (
                None
                if self.max_ball_speed_mps is None or not math.isfinite(self.max_ball_speed_mps)
                else round(self.max_ball_speed_mps, 2)
            ),
            "evidence": [e.to_dict() for e in self.evidence],
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "RallySegment":
        return cls(
            idx=int(d["idx"]),
            start_s=float(d["start_s"]),
            end_s=float(d["end_s"]),
            clip_start_s=float(d.get("clip_start_s", d["start_s"])),
            clip_end_s=float(d.get("clip_end_s", d["end_s"])),
            start_reason=StartReason(d.get("start_reason", "ball_motion_onset")),
            end_reason=EndReason(d.get("end_reason", "low_activity")),
            confidence=float(d.get("confidence", 0.0)),
            start_confidence=float(d.get("start_confidence", 0.0)),
            end_confidence=float(d.get("end_confidence", 0.0)),
            shots=int(d.get("shots", 0)),
            net_crossings=int(d.get("net_crossings", 0)),
            bounces=int(d.get("bounces", 0)),
            ball_coverage=float(d.get("ball_coverage", 0.0)),
            mean_player_activity=float(d.get("mean_player_activity", 0.0)),
            max_ball_speed_mps=d.get("max_ball_speed_mps"),
            evidence=[
                Evidence(e["name"], float(e["t_s"]), float(e["score"]), e.get("detail", {}))
                for e in d.get("evidence", [])
            ],
        )


@dataclass
class SegmentationResult:
    video_path: str
    duration_s: float
    fps: float
    width: int
    height: int
    rallies: List[RallySegment] = field(default_factory=list)

    segmenter: str = "rule_based"
    schema_version: str = SCHEMA_VERSION
    pipeline_version: str = "1.0.0"

    # Diagnostics the operator needs when a run looks wrong.
    court_detected: bool = False
    court_confidence: float = 0.0
    ball_detector: str = "unknown"
    frames_processed: int = 0
    ball_detection_rate: float = 0.0
    warnings: List[str] = field(default_factory=list)
    timings_s: Dict[str, float] = field(default_factory=dict)
    config_digest: str = ""

    @property
    def play_fraction(self) -> float:
        if self.duration_s <= 0:
            return 0.0
        return sum(r.duration_s for r in self.rallies) / self.duration_s

    def to_dict(self) -> Dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "pipeline_version": self.pipeline_version,
            "video_path": self.video_path,
            "duration_s": round(self.duration_s, 3),
            "fps": round(self.fps, 4),
            "width": self.width,
            "height": self.height,
            "segmenter": self.segmenter,
            "rally_count": len(self.rallies),
            "play_fraction": round(self.play_fraction, 4),
            "court_detected": self.court_detected,
            "court_confidence": round(self.court_confidence, 4),
            "ball_detector": self.ball_detector,
            "frames_processed": self.frames_processed,
            "ball_detection_rate": round(self.ball_detection_rate, 4),
            "warnings": self.warnings,
            "timings_s": {k: round(v, 3) for k, v in self.timings_s.items()},
            "config_digest": self.config_digest,
            "rallies": [r.to_dict() for r in self.rallies],
        }

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SegmentationResult":
        res = cls(
            video_path=d.get("video_path", ""),
            duration_s=float(d.get("duration_s", 0.0)),
            fps=float(d.get("fps", 0.0)),
            width=int(d.get("width", 0)),
            height=int(d.get("height", 0)),
            rallies=[RallySegment.from_dict(r) for r in d.get("rallies", [])],
            segmenter=d.get("segmenter", "rule_based"),
            schema_version=d.get("schema_version", SCHEMA_VERSION),
            pipeline_version=d.get("pipeline_version", "unknown"),
            court_detected=bool(d.get("court_detected", False)),
            court_confidence=float(d.get("court_confidence", 0.0)),
            ball_detector=d.get("ball_detector", "unknown"),
            frames_processed=int(d.get("frames_processed", 0)),
            ball_detection_rate=float(d.get("ball_detection_rate", 0.0)),
            warnings=list(d.get("warnings", [])),
            timings_s=dict(d.get("timings_s", {})),
            config_digest=d.get("config_digest", ""),
        )
        return res
