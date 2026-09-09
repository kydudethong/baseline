"""Evaluation against hand-labelled rallies.

Segment IoU alone is the wrong metric here.  A segmenter that finds every rally
but is a second late on each start scores well on IoU and produces clips that
miss the serve.  So boundary error is measured separately and reported at
several tolerances, and over-/under-segmentation is counted explicitly, because
those two failure modes need different fixes: splitting means the gap tolerance
is too tight, merging means the end evidence is too weak.

Ground truth format (JSON), either shape::

    [{"start_s": 12.4, "end_s": 19.8}, ...]
    {"rallies": [{"start_s": 12.4, "end_s": 19.8}, ...]}
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Sequence, Tuple

import numpy as np

from .schema import RallySegment

DEFAULT_TOLERANCES = (0.25, 0.5, 1.0, 2.0)

#: Seconds a predicted start may be from a true start and still count as
#: "landing the player in the right place" when they press next-rally.
JUMP_TOLERANCE_S = 1.5


@dataclass
class Interval:
    start_s: float
    end_s: float

    @property
    def duration_s(self) -> float:
        return max(0.0, self.end_s - self.start_s)


def load_ground_truth(path: str) -> List[Interval]:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        data = data.get("rallies", data.get("segments", []))
    out = []
    for item in data:
        out.append(Interval(float(item["start_s"]), float(item["end_s"])))
    return sorted(out, key=lambda i: i.start_s)


def iou(a: Interval, b: Interval) -> float:
    inter = max(0.0, min(a.end_s, b.end_s) - max(a.start_s, b.start_s))
    union = a.duration_s + b.duration_s - inter
    return inter / union if union > 0 else 0.0


@dataclass
class EvalReport:
    n_pred: int
    n_true: int
    matched: int
    precision: float
    recall: float
    f1: float
    mean_iou: float
    start_mae_s: float
    end_mae_s: float
    start_median_s: float
    end_median_s: float
    #: Fraction of true rallies with *some* predicted start within
    #: JUMP_TOLERANCE_S.  Recall on starts only, and the closest thing here to a
    #: product metric: it is what decides whether a next-rally button lands the
    #: player where they expect, even when the predicted window's exact shape is
    #: imperfect.  Deliberately forgiving about everything F1 is strict about.
    jump_accuracy: float = 0.0
    boundary_f1: Dict[str, float] = field(default_factory=dict)
    over_segmentation: float = 0.0     # predicted spans per true rally, above 1
    under_segmentation: float = 0.0    # true rallies per predicted span, above 1
    coverage: float = 0.0              # fraction of true rally time covered
    leakage: float = 0.0               # predicted time that is not rally time
    per_rally: List[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

    def summary(self) -> str:
        lines = [
            f"rallies: {self.n_pred} predicted / {self.n_true} labelled, {self.matched} matched",
            f"P {self.precision:.3f}  R {self.recall:.3f}  F1 {self.f1:.3f}  mIoU {self.mean_iou:.3f}",
            f"jump accuracy {self.jump_accuracy:.3f}  (start within ±{JUMP_TOLERANCE_S}s)",
            f"start error  mean {self.start_mae_s:.3f}s  median {self.start_median_s:.3f}s",
            f"end   error  mean {self.end_mae_s:.3f}s  median {self.end_median_s:.3f}s",
            "boundary F1  " + "  ".join(f"±{k}s {v:.3f}" for k, v in self.boundary_f1.items()),
            f"over-seg {self.over_segmentation:.3f}  under-seg {self.under_segmentation:.3f}",
            f"coverage {self.coverage:.3f}  leakage {self.leakage:.3f}",
        ]
        return "\n".join(lines)


def evaluate(pred: Sequence[RallySegment], truth: Sequence[Interval],
             iou_threshold: float = 0.5,
             tolerances: Sequence[float] = DEFAULT_TOLERANCES) -> EvalReport:
    p = [Interval(s.start_s, s.end_s) for s in pred]
    t = list(truth)

    # Greedy one-to-one matching on IoU.
    pairs: List[Tuple[float, int, int]] = []
    for i, pi in enumerate(p):
        for j, tj in enumerate(t):
            v = iou(pi, tj)
            if v > 0:
                pairs.append((-v, i, j))
    pairs.sort()
    used_p, used_t = set(), set()
    matches: List[Tuple[int, int, float]] = []
    for neg_v, i, j in pairs:
        if i in used_p or j in used_t:
            continue
        v = -neg_v
        if v < iou_threshold:
            continue
        matches.append((i, j, v))
        used_p.add(i)
        used_t.add(j)

    matched = len(matches)
    precision = matched / len(p) if p else 0.0
    recall = matched / len(t) if t else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    mean_iou = float(np.mean([m[2] for m in matches])) if matches else 0.0

    start_err = [abs(p[i].start_s - t[j].start_s) for i, j, _ in matches]
    end_err = [abs(p[i].end_s - t[j].end_s) for i, j, _ in matches]

    boundary_f1 = {
        str(tol): _boundary_f1(p, t, tol) for tol in tolerances
    }

    # Over/under segmentation: how many predictions overlap each truth and back.
    overlaps_per_truth = [sum(1 for pi in p if iou(pi, tj) > 0.1) for tj in t]
    overlaps_per_pred = [sum(1 for tj in t if iou(pi, tj) > 0.1) for pi in p]
    over = float(np.mean([max(0, c - 1) for c in overlaps_per_truth])) if t else 0.0
    under = float(np.mean([max(0, c - 1) for c in overlaps_per_pred])) if p else 0.0

    truth_time = sum(x.duration_s for x in t)
    covered = sum(
        max(0.0, min(pi.end_s, tj.end_s) - max(pi.start_s, tj.start_s))
        for tj in t for pi in p
    )
    pred_time = sum(x.duration_s for x in p)
    coverage = covered / truth_time if truth_time else 0.0
    leakage = max(0.0, (pred_time - covered)) / pred_time if pred_time else 0.0

    per_rally = [
        {
            "pred_idx": i, "true_idx": j, "iou": round(v, 4),
            "start_err_s": round(p[i].start_s - t[j].start_s, 3),
            "end_err_s": round(p[i].end_s - t[j].end_s, 3),
            "confidence": round(pred[i].confidence, 3),
            "end_reason": pred[i].end_reason.value,
        }
        for i, j, v in sorted(matches, key=lambda m: m[0])
    ]

    jumps = sum(
        1 for tj in t
        if any(abs(pi.start_s - tj.start_s) <= JUMP_TOLERANCE_S for pi in p)
    )
    jump_accuracy = jumps / len(t) if t else 1.0

    return EvalReport(
        n_pred=len(p), n_true=len(t), matched=matched, jump_accuracy=jump_accuracy,
        precision=precision, recall=recall, f1=f1, mean_iou=mean_iou,
        start_mae_s=float(np.mean(start_err)) if start_err else float("nan"),
        end_mae_s=float(np.mean(end_err)) if end_err else float("nan"),
        start_median_s=float(np.median(start_err)) if start_err else float("nan"),
        end_median_s=float(np.median(end_err)) if end_err else float("nan"),
        boundary_f1=boundary_f1, over_segmentation=over, under_segmentation=under,
        coverage=coverage, leakage=leakage, per_rally=per_rally,
    )


def _boundary_f1(pred: Sequence[Interval], truth: Sequence[Interval], tol: float) -> float:
    """Treat every start and end as a point event and match within ``tol``."""
    pb = sorted([x.start_s for x in pred] + [x.end_s for x in pred])
    tb = sorted([x.start_s for x in truth] + [x.end_s for x in truth])
    if not pb or not tb:
        return 0.0
    used = set()
    hits = 0
    for b in pb:
        best, best_d = -1, tol
        for k, g in enumerate(tb):
            if k in used:
                continue
            d = abs(b - g)
            if d <= best_d:
                best, best_d = k, d
        if best >= 0:
            used.add(best)
            hits += 1
    precision = hits / len(pb)
    recall = hits / len(tb)
    return 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0


def score_for_tuning(report: EvalReport) -> float:
    """One number for the calibrator to maximise.

    Weighted toward boundary tightness rather than raw detection, because
    missing a rally is recoverable by lowering a threshold and a systematically
    late start is not -- it silently ruins every clip the app cuts.
    """
    b_half = report.boundary_f1.get("0.5", 0.0)
    penalty = 0.1 * report.over_segmentation + 0.1 * report.under_segmentation
    return float(0.40 * report.f1 + 0.25 * report.jump_accuracy + 0.20 * b_half
                 + 0.15 * report.mean_iou - penalty)
