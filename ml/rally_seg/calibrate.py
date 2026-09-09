"""Threshold calibration against labelled clips.

The defaults in ``config.py`` are reasoned, not measured -- they cannot be
measured, because they depend on how *you* film: camera height, distance behind
the baseline, 30 vs 60 fps, indoor lighting versus a sunlit outdoor court with
hard shadows.  Calibration is how the pipeline adapts to a specific setup, and
it is cheap because perception is cached: a full sweep re-runs only the state
machine, thousands of times a second.

Coordinate descent rather than a full grid.  The parameters are close to
separable (the ball-gap tolerance and the start threshold barely interact), a
grid over eight knobs is millions of evaluations, and two or three passes of
coordinate descent lands in the same place.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from .config import Config
from .evaluate import EvalReport, Interval, evaluate, score_for_tuning
from .features import FeatureStream
from .models.rule_based import RuleBasedSegmenter

#: What to sweep, and over what.  Deliberately short: every extra knob is more
#: chances to overfit a small label set.
DEFAULT_SEARCH_SPACE: Dict[str, List[float]] = {
    "state.start_threshold": [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70],
    "state.stop_threshold": [0.20, 0.25, 0.30, 0.35, 0.40, 0.45],
    "state.max_ball_gap_s": [0.6, 0.8, 1.0, 1.1, 1.3, 1.6, 2.0],
    "state.quiet_ball_gap_s": [0.3, 0.4, 0.5, 0.7, 0.9],
    "state.quiet_activity_threshold": [0.06, 0.09, 0.12, 0.16, 0.22],
    "state.start_hold_frames": [2, 3, 4, 6, 8],
    "state.stop_hold_frames": [5, 8, 10, 14, 20],
    "state.merge_gap_s": [0.4, 0.7, 0.9, 1.2, 1.8],
    "state.min_rally_s": [0.8, 1.2, 1.6, 2.0],
    "state.lead_s": [0.25, 0.35, 0.45, 0.6, 0.8],
    "state.tail_s": [0.4, 0.55, 0.7, 0.9, 1.2],
}


@dataclass
class LabelledClip:
    name: str
    stream: FeatureStream
    truth: List[Interval]


@dataclass
class CalibrationResult:
    best_overrides: Dict[str, float]
    best_score: float
    baseline_score: float
    report: Optional[EvalReport] = None
    history: List[Tuple[str, float, float]] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "best_overrides": self.best_overrides,
            "best_score": round(self.best_score, 5),
            "baseline_score": round(self.baseline_score, 5),
            "improvement": round(self.best_score - self.baseline_score, 5),
            "report": self.report.to_dict() if self.report else None,
            "history": [{"key": k, "value": v, "score": round(s, 5)} for k, v, s in self.history],
        }


def score_config(cfg: Config, clips: Sequence[LabelledClip]) -> Tuple[float, EvalReport]:
    """Mean tuning score across clips, plus the pooled report.

    Pooled rather than averaged for the report so a two-minute clip does not
    count as much as a forty-minute match.
    """
    seg = RuleBasedSegmenter(cfg.state)
    all_pred, all_truth = [], []
    scores = []
    offset = 0.0
    for clip in clips:
        pred = seg.segment(clip.stream)
        rep = evaluate(pred, clip.truth)
        scores.append(score_for_tuning(rep))
        # Shift each clip onto its own stretch of a virtual timeline so the
        # pooled report cannot match a rally in clip A to one in clip B.
        span = float(clip.stream.t[-1]) + 60.0 if len(clip.stream) else 60.0
        for s in pred:
            shifted = copy.copy(s)
            shifted.start_s += offset
            shifted.end_s += offset
            all_pred.append(shifted)
        for g in clip.truth:
            all_truth.append(Interval(g.start_s + offset, g.end_s + offset))
        offset += span
    pooled = evaluate(all_pred, all_truth)
    return float(np.mean(scores)) if scores else 0.0, pooled


def calibrate(cfg: Config, clips: Sequence[LabelledClip],
              space: Optional[Dict[str, List[float]]] = None,
              passes: int = 3, verbose: bool = True) -> CalibrationResult:
    space = space or DEFAULT_SEARCH_SPACE
    best_cfg = cfg.copy()
    baseline, _ = score_config(best_cfg, clips)
    best_score = baseline
    history: List[Tuple[str, float, float]] = []

    for p in range(passes):
        improved = False
        for key, values in space.items():
            current = best_cfg.get_dotted(key)
            local_best_value, local_best_score = current, best_score
            for value in values:
                if value == current:
                    continue
                trial = best_cfg.copy().override({key: value})
                score, _ = score_config(trial, clips)
                history.append((key, float(value), score))
                if score > local_best_score + 1e-6:
                    local_best_value, local_best_score = value, score
            if local_best_value != current:
                best_cfg.override({key: local_best_value})
                best_score = local_best_score
                improved = True
                if verbose:
                    print(f"  pass {p + 1}: {key} {current} -> {local_best_value}  "
                          f"score {best_score:.4f}")
        if not improved:
            break

    _final_score, report = score_config(best_cfg, clips)
    overrides = {
        key: best_cfg.get_dotted(key)
        for key in space
        if best_cfg.get_dotted(key) != cfg.get_dotted(key)
    }
    return CalibrationResult(best_overrides=overrides, best_score=best_score,
                             baseline_score=baseline, report=report, history=history)


def overrides_to_yaml(overrides: Dict[str, float]) -> str:
    """Render the winning overrides as a config fragment ready to paste."""
    tree: Dict[str, Dict[str, float]] = {}
    for key, value in overrides.items():
        section, leaf = key.split(".", 1)
        tree.setdefault(section, {})[leaf] = value
    lines: List[str] = []
    for section, leaves in tree.items():
        lines.append(f"{section}:")
        for leaf, value in leaves.items():
            lines.append(f"  {leaf}: {value}")
    return "\n".join(lines)
