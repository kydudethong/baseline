"""The segmenter interface.

A segmenter maps a ``FeatureStream`` to a list of ``RallySegment``.  That is the
entire contract.  It gets no access to the video, the detector or the config
beyond what it was constructed with, which is what keeps the rule-based and
learned implementations genuinely interchangeable -- and what makes it possible
to evaluate one against the other on identical inputs.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import List, Optional

import numpy as np

from ..features import FeatureStream
from ..schema import EndReason, RallySegment

#: Endings that are evidence of a completed point rather than a lost track.
#: Two segments either side of one of these are two rallies, however small the
#: gap between them -- merging across a ball that landed out is always wrong.
DECISIVE_ENDINGS = {
    EndReason.OUT_OF_BOUNDS,
    EndReason.NET_CONTACT,
    EndReason.BALL_GROUNDED,
    EndReason.NEXT_SERVE,
}


class RallySegmenter(ABC):
    name: str = "base"

    @abstractmethod
    def segment(self, stream: FeatureStream) -> List[RallySegment]:
        ...

    def frame_probability(self, stream: FeatureStream) -> Optional[np.ndarray]:
        """Per-frame P(in rally), when the implementation exposes one.

        Used by the ensemble segmenter and by the debug overlay.  Returning
        ``None`` is fine.
        """
        return None


def postprocess(segments: List[RallySegment], min_rally_s: float, max_rally_s: float,
                merge_gap_s: float, duration_s: float,
                lead_s: float = 0.0, tail_s: float = 0.0,
                require_play_evidence: bool = True) -> List[RallySegment]:
    """Shared cleanup so every segmenter obeys the same sanity rules."""
    if not segments:
        return []
    segments = sorted(segments, key=lambda s: s.start_s)

    merged: List[RallySegment] = [segments[0]]
    for seg in segments[1:]:
        prev = merged[-1]
        decisive = (prev.end_reason in DECISIVE_ENDINGS and prev.end_confidence >= 0.6)
        if seg.start_s - prev.end_s <= merge_gap_s and not decisive:
            # One rally seen through a dropout.  Keep the outer boundaries and
            # the *weaker* confidence, because a merge means one of the two
            # boundary calls was wrong.
            prev.end_s = max(prev.end_s, seg.end_s)
            prev.end_reason = seg.end_reason
            prev.end_confidence = min(prev.end_confidence, seg.end_confidence)
            prev.shots += seg.shots
            prev.net_crossings += seg.net_crossings
            prev.bounces += seg.bounces
            prev.evidence.extend(seg.evidence)
            prev.confidence = min(prev.confidence, seg.confidence)
        else:
            merged.append(seg)

    out: List[RallySegment] = []
    for seg in merged:
        if seg.duration_s < min_rally_s:
            continue
        if seg.duration_s > max_rally_s:
            seg.end_s = seg.start_s + max_rally_s
            seg.confidence = min(seg.confidence, 0.35)
        seg.start_s = max(0.0, seg.start_s)
        if duration_s > 0:
            seg.end_s = min(duration_s, seg.end_s)
        if seg.end_s <= seg.start_s:
            continue
        out.append(seg)

    # Padding can push a start behind the previous end.  Overlapping rallies
    # are meaningless downstream -- the app cuts clips from these -- so give the
    # overlap to whichever boundary was more confidently placed.
    for prev, seg in zip(out, out[1:]):
        if seg.start_s < prev.end_s:
            if seg.start_confidence >= prev.end_confidence:
                prev.end_s = seg.start_s
            else:
                seg.start_s = prev.end_s
    out = [s for s in out if s.end_s > s.start_s]

    # A span in which the ball never crossed the net and was struck at most
    # once is not a rally, whatever the score said.  This is what removes the
    # phantom "rallies" that a ball rolling to a stop after a real point can
    # otherwise generate.
    if require_play_evidence:
        out = [
            s for s in out
            if s.net_crossings >= 1 or (s.shots >= 3 and s.ball_coverage >= 0.4)
        ]

    # Clip bounds are derived last, after every boundary is final.
    for seg in out:
        seg.clip_start_s = max(0.0, seg.start_s - lead_s)
        seg.clip_end_s = seg.end_s + tail_s
        if duration_s > 0:
            seg.clip_end_s = min(duration_s, seg.clip_end_s)

    for i, seg in enumerate(out):
        seg.idx = i
    return out
