"""Learned temporal segmentation -- the replacement path for the state machine.

The rule-based segmenter is a strong prior, not a ceiling.  Once there is a few
hours of labelled footage, a temporal convolutional network over the *same*
feature stream will beat it, because it can learn things the rules cannot state:
how long a particular camera angle takes to lose the ball, what the two seconds
before a serve look like at this club, that a rally ending on a smash looks
different from one ending on a missed dink.

A dilated TCN rather than an LSTM, for three reasons: the receptive field is
explicit (and needs to be ~8 seconds, which is what the dilation schedule below
gives at 30 fps), it trains in minutes on CPU at this feature width, and it is
causal-optional -- the same architecture serves offline batch analysis and, with
``causal=True``, a future live mode.

The network predicts three per-frame heads:

    p_rally    is this frame inside a rally
    p_start    is this frame a rally start boundary
    p_end      is this frame a rally end boundary

Boundary heads matter.  Training only on the in-rally mask gives a model that is
right 95% of the time and vague about exactly where rallies begin -- which is
the one number this pipeline exists to produce.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import List, Optional, Tuple

import numpy as np

from ..config import StateMachineConfig
from ..features import FEATURE_VERSION, N_FEATURES, FeatureStream
from ..schema import EndReason, Evidence, RallySegment, StartReason
from .base import RallySegmenter, postprocess

try:  # torch is optional: the rule-based path must work without it
    import torch  # type: ignore
    import torch.nn as nn  # type: ignore
    _HAS_TORCH = True
except ImportError:  # pragma: no cover
    _HAS_TORCH = False
    torch = None  # type: ignore
    nn = object  # type: ignore


DEFAULT_DILATIONS = (1, 2, 4, 8, 16, 32, 64)   # ~8 s receptive field at 30 fps


if _HAS_TORCH:

    class _Block(nn.Module):
        def __init__(self, ch: int, dilation: int, dropout: float, causal: bool):
            super().__init__()
            self.causal = causal
            self.dilation = dilation
            pad = dilation * 2 if causal else dilation
            self.conv1 = nn.Conv1d(ch, ch, 3, padding=pad if causal else dilation,
                                   dilation=dilation)
            self.conv2 = nn.Conv1d(ch, ch, 1)
            self.norm = nn.GroupNorm(4, ch)
            self.act = nn.GELU()
            self.drop = nn.Dropout(dropout)

        def forward(self, x):  # (B, C, T)
            y = self.conv1(x)
            if self.causal:
                y = y[..., : x.shape[-1]]
            y = self.drop(self.act(self.norm(y)))
            y = self.conv2(y)
            return x + y

    class RallyTCN(nn.Module):
        def __init__(self, in_dim: int = N_FEATURES, hidden: int = 64,
                     dilations: Tuple[int, ...] = DEFAULT_DILATIONS,
                     dropout: float = 0.1, causal: bool = False):
            super().__init__()
            self.stem = nn.Conv1d(in_dim, hidden, 1)
            self.blocks = nn.ModuleList([_Block(hidden, d, dropout, causal) for d in dilations])
            self.head = nn.Conv1d(hidden, 3, 1)   # rally, start, end
            self.causal = causal
            self.hidden = hidden
            self.dilations = tuple(dilations)

        def forward(self, x):  # (B, T, F) -> (B, T, 3) logits
            h = self.stem(x.transpose(1, 2))
            for block in self.blocks:
                h = block(h)
            return self.head(h).transpose(1, 2)


@dataclass
class NormStats:
    mean: np.ndarray
    std: np.ndarray

    def apply(self, X: np.ndarray) -> np.ndarray:
        return (X - self.mean) / np.maximum(1e-6, self.std)

    def to_dict(self) -> dict:
        return {"mean": self.mean.tolist(), "std": self.std.tolist()}

    @classmethod
    def from_dict(cls, d: dict) -> "NormStats":
        return cls(np.array(d["mean"], dtype=np.float32), np.array(d["std"], dtype=np.float32))

    @classmethod
    def fit(cls, X: np.ndarray) -> "NormStats":
        return cls(X.mean(axis=0).astype(np.float32),
                   (X.std(axis=0) + 1e-6).astype(np.float32))


class TemporalSegmenter(RallySegmenter):
    """Runs a trained ``RallyTCN`` and decodes its outputs into segments."""

    name = "temporal"

    def __init__(self, weights_path: str, cfg: StateMachineConfig,
                 rally_threshold: float = 0.5, boundary_threshold: float = 0.35,
                 device: str = "auto"):
        if not _HAS_TORCH:
            raise RuntimeError("torch is required for the temporal segmenter")
        if not os.path.exists(weights_path):
            raise FileNotFoundError(
                f"temporal weights not found at {weights_path}. Train one with "
                "`python -m rally_seg.train.train_temporal`, or use segmenter.kind=rule_based."
            )
        ckpt = torch.load(weights_path, map_location="cpu")
        if ckpt.get("feature_version") != FEATURE_VERSION:
            raise ValueError(
                f"checkpoint was trained on feature_version {ckpt.get('feature_version')}, "
                f"this build produces {FEATURE_VERSION}; retrain or pin the older build"
            )
        self.cfg = cfg
        self.rally_threshold = rally_threshold
        self.boundary_threshold = boundary_threshold
        self.device = _resolve_torch_device(device)
        arch = ckpt.get("arch", {})
        self.model = RallyTCN(
            in_dim=arch.get("in_dim", N_FEATURES),
            hidden=arch.get("hidden", 64),
            dilations=tuple(arch.get("dilations", DEFAULT_DILATIONS)),
            causal=arch.get("causal", False),
        )
        self.model.load_state_dict(ckpt["state_dict"])
        self.model.to(self.device).eval()
        self.norm = NormStats.from_dict(ckpt["norm"])

    # --- inference ---------------------------------------------------------

    def _predict(self, stream: FeatureStream) -> np.ndarray:
        X = self.norm.apply(stream.X.astype(np.float32))
        with torch.no_grad():
            tensor = torch.from_numpy(X[None]).to(self.device)
            logits = self.model(tensor)
            probs = torch.sigmoid(logits)[0].cpu().numpy()
        return probs      # (T, 3)

    def frame_probability(self, stream: FeatureStream) -> Optional[np.ndarray]:
        if len(stream) == 0:
            return np.zeros(0, dtype=np.float32)
        return self._predict(stream)[:, 0].astype(np.float32)

    def segment(self, stream: FeatureStream) -> List[RallySegment]:
        if len(stream) == 0:
            return []
        probs = self._predict(stream)
        return decode_segments(stream, probs, self.cfg, self.rally_threshold,
                               self.boundary_threshold, source=StartReason.MODEL)


def decode_segments(stream: FeatureStream, probs: np.ndarray, cfg: StateMachineConfig,
                    rally_threshold: float, boundary_threshold: float,
                    source: StartReason = StartReason.MODEL) -> List[RallySegment]:
    """Threshold the rally mask, then pull each boundary onto its peak.

    The mask gives roughly-right spans; the boundary heads give precisely-right
    edges.  Using both is what keeps timestamps tight enough to cut clips from.
    """
    from ..events import BOUNCE, NET_CROSS, PADDLE_CONTACT

    p_rally, p_start, p_end = probs[:, 0], probs[:, 1], probs[:, 2]
    inside = p_rally >= rally_threshold
    n = len(stream)
    t = stream.t

    spans: List[Tuple[int, int]] = []
    i = 0
    while i < n:
        if not inside[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and inside[j + 1]:
            j += 1
        spans.append((i, j))
        i = j + 1

    fps = stream.fps or 30.0
    search = max(2, int(0.6 * fps))
    segments: List[RallySegment] = []
    for (i0, i1) in spans:
        s_lo, s_hi = max(0, i0 - search), min(n - 1, i0 + search)
        e_lo, e_hi = max(0, i1 - search), min(n - 1, i1 + search)
        si = int(s_lo + np.argmax(p_start[s_lo : s_hi + 1]))
        ei = int(e_lo + np.argmax(p_end[e_lo : e_hi + 1]))
        if p_start[si] < boundary_threshold:
            si = i0
        if p_end[ei] < boundary_threshold or ei <= si:
            ei = i1

        start_s = float(t[si])
        end_s = float(t[ei])
        w = slice(si, max(si + 1, ei))
        evs = stream.events_between(start_s, end_s)
        seg = RallySegment(
            idx=0, start_s=max(0.0, start_s), end_s=end_s,
            clip_start_s=max(0.0, start_s - cfg.lead_s), clip_end_s=end_s + cfg.tail_s,
            start_reason=source, end_reason=EndReason.MODEL,
            start_confidence=float(p_start[si]), end_confidence=float(p_end[ei]),
            shots=sum(1 for e in evs if e.kind == PADDLE_CONTACT),
            net_crossings=sum(1 for e in evs if e.kind == NET_CROSS),
            bounces=sum(1 for e in evs if e.kind == BOUNCE),
            ball_coverage=float(stream.col("ball_observed")[w].mean()) if ei > si else 0.0,
            mean_player_activity=float(stream.col("player_activity_w")[w].mean()) if ei > si else 0.0,
            evidence=[
                Evidence("p_rally", float(t[si]), float(p_rally[si:ei].mean() if ei > si else 0.0), {}),
                Evidence("p_start", float(t[si]), float(p_start[si]), {}),
                Evidence("p_end", float(t[ei]), float(p_end[ei]), {}),
            ],
        )
        seg.confidence = float(np.clip(
            0.5 * (seg.start_confidence + seg.end_confidence)
            * (0.6 + 0.4 * float(p_rally[si:ei].mean() if ei > si else 0.0)), 0.0, 0.99))
        segments.append(seg)

    duration = float(t[-1]) if n else 0.0
    return postprocess(segments, cfg.min_rally_s, cfg.max_rally_s, cfg.merge_gap_s, duration,
                       lead_s=cfg.lead_s, tail_s=cfg.tail_s, require_play_evidence=False)


class EnsembleSegmenter(RallySegmenter):
    """Blend the learned rally mask with the rule-based score.

    The intended migration path: ship rules, collect labels, train, run the
    ensemble at alpha 0.5 while the model is unproven, then walk alpha to 1.0
    once the eval numbers say to.  At no point does the app change.
    """

    name = "ensemble"

    def __init__(self, rule, temporal: "TemporalSegmenter", cfg: StateMachineConfig,
                 alpha: float = 0.5):
        self.rule = rule
        self.temporal = temporal
        self.cfg = cfg
        self.alpha = float(np.clip(alpha, 0.0, 1.0))

    def frame_probability(self, stream: FeatureStream) -> Optional[np.ndarray]:
        rule_p = self.rule.frame_probability(stream)
        model_p = self.temporal.frame_probability(stream)
        if rule_p is None or model_p is None:
            return model_p if rule_p is None else rule_p
        return (1.0 - self.alpha) * rule_p + self.alpha * model_p

    def segment(self, stream: FeatureStream) -> List[RallySegment]:
        probs = self.temporal._predict(stream)
        rule_p = self.rule.frame_probability(stream)
        if rule_p is not None and len(rule_p) == len(probs):
            probs = probs.copy()
            probs[:, 0] = (1.0 - self.alpha) * rule_p + self.alpha * probs[:, 0]
        return decode_segments(stream, probs, self.cfg, 0.5, 0.35)


def _resolve_torch_device(requested: str) -> str:
    if requested and requested != "auto":
        return requested
    if not _HAS_TORCH:
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def build_segmenter(cfg) -> RallySegmenter:
    """Factory used by the pipeline.  One config key selects the whole strategy."""
    from .rule_based import RuleBasedSegmenter

    kind = (cfg.segmenter.kind or "rule_based").lower()
    rule = RuleBasedSegmenter(cfg.state)
    if kind == "rule_based":
        return rule
    temporal = TemporalSegmenter(cfg.segmenter.temporal_weights, cfg.state)
    if kind == "temporal":
        return temporal
    if kind == "ensemble":
        return EnsembleSegmenter(rule, temporal, cfg.state, cfg.segmenter.ensemble_alpha)
    raise ValueError(f"unknown segmenter kind: {cfg.segmenter.kind}")
