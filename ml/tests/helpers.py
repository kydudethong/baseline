"""Build synthetic feature streams directly.

Testing the state machine through a video would test the detector instead.
These helpers write the feature stream by hand, so a test can state exactly what
the perception layer saw -- including the cases that are hard to film on
purpose, like a ball occluded for precisely 0.7 seconds while the players keep
running.
"""

from __future__ import annotations

from typing import Optional, Tuple

import numpy as np

from rally_seg.events import Event
from rally_seg.features import FEATURE_INDEX, GAP_REFERENCE_S, N_FEATURES, FeatureStream


def make_stream(duration_s: float = 30.0, fps: float = 30.0) -> FeatureStream:
    n = int(duration_s * fps)
    return FeatureStream(
        fps=fps, width=960, height=540,
        t=np.arange(n) / fps,
        frame_index=np.arange(n),
        X=np.zeros((n, N_FEATURES), dtype=np.float32),
        events=[],
    )


def _set(stream: FeatureStream, name: str, i0: int, i1: int, value: float) -> None:
    stream.X[i0:i1, FEATURE_INDEX[name]] = value


def add_play(stream: FeatureStream, t0: float, t1: float, *,
             ball: bool = True, activity: float = 0.45, speed: float = 0.9,
             cross_rate: float = 0.8, contact_rate: float = 1.4) -> Tuple[int, int]:
    """Mark a stretch as live play: ball visible and moving, players working."""
    i0, i1 = stream.index_at(t0), stream.index_at(t1)
    _set(stream, "ball_present", i0, i1, 1.0 if ball else 0.0)
    _set(stream, "ball_observed", i0, i1, 1.0 if ball else 0.0)
    _set(stream, "ball_conf", i0, i1, 0.8 if ball else 0.0)
    _set(stream, "ball_speed", i0, i1, speed if ball else 0.0)
    _set(stream, "rate_net_cross", i0, i1, cross_rate)
    _set(stream, "rate_contact", i0, i1, contact_rate)
    _set(stream, "player_activity", i0, i1, activity)
    _set(stream, "player_activity_w", i0, i1, activity)
    _set(stream, "n_players", i0, i1, 1.0)
    _set(stream, "court_valid", i0, i1, 1.0)
    return i0, i1


def add_gap(stream: FeatureStream, t0: float, t1: float, *, activity: float) -> None:
    """The ball vanishes.  ``activity`` decides whether that is an occlusion or an ending."""
    i0, i1 = stream.index_at(t0), stream.index_at(t1)
    _set(stream, "ball_present", i0, i1, 0.0)
    _set(stream, "ball_observed", i0, i1, 0.0)
    _set(stream, "ball_conf", i0, i1, 0.0)
    _set(stream, "ball_speed", i0, i1, 0.0)
    _set(stream, "player_activity", i0, i1, activity)
    _set(stream, "player_activity_w", i0, i1, activity)
    # gap_norm ramps from the start of the gap, the way the builder produces it.
    for k, i in enumerate(range(i0, i1)):
        stream.X[i, FEATURE_INDEX["gap_norm"]] = min(
            1.0, (k / stream.fps) / GAP_REFERENCE_S)


def add_idle(stream: FeatureStream, t0: float, t1: float) -> None:
    i0, i1 = stream.index_at(t0), stream.index_at(t1)
    stream.X[i0:i1, :] = 0.0
    _set(stream, "gap_norm", i0, i1, 1.0)


def add_event(stream: FeatureStream, kind: str, t_s: float, conf: float = 0.9,
              detail: Optional[dict] = None, feature: Optional[str] = None) -> Event:
    ev = Event(kind, t_s, stream.index_at(t_s), conf, detail or {})
    stream.events.append(ev)
    stream.events.sort(key=lambda e: e.t_s)
    if feature:
        stream.X[stream.index_at(t_s), FEATURE_INDEX[feature]] = conf
    return ev
