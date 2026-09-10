"""The court gate: who counts as standing on this court.

This is what the setup screen's "re-detect" leans on. It refits the court
against the sampled line colour and then keeps only the people standing on the
court it found -- so the gate is the half that decides whether spectators, the
queue behind the fence and the neighbours' game come back as players.

Pure geometry, so it is worth pinning here rather than discovering on footage.
"""
import cv2
import numpy as np

from rally_seg.config import Config
from rally_seg.detect.court import CourtModel
from rally_seg.pipeline import _player_gate_polygon

IMAGE = (960, 540)
# A court seen from behind its near baseline: the far edge is shorter and
# higher up the frame, as perspective requires.
QUAD = np.array([[150.0, 505.0], [810.0, 505.0], [612.0, 150.0], [348.0, 150.0]],
                dtype=np.float32)


def gate():
    court = CourtModel.from_corners(QUAD, IMAGE)
    return _player_gate_polygon(court, Config(), IMAGE)


def inside(poly, x, y) -> bool:
    return cv2.pointPolygonTest(poly, (float(x), float(y)), False) >= 0


def test_a_player_on_the_court_is_kept():
    poly = gate()
    assert inside(poly, 480, 400), "mid court"
    assert inside(poly, 480, 200), "near the far baseline"


def test_a_spectator_behind_the_far_baseline_is_dropped():
    # Bleachers, the queue, the next court up -- all of it lives above the far
    # baseline, and this is the case the gate exists for.
    poly = gate()
    assert not inside(poly, 480, 60)
    assert not inside(poly, 300, 100)


def test_the_neighbouring_court_either_side_is_dropped():
    poly = gate()
    assert not inside(poly, 60, 400), "well left of the left sideline"
    assert not inside(poly, 900, 400), "well right of the right sideline"


def test_a_player_at_or_past_the_bottom_of_the_frame_is_kept():
    """The documented failure this was fixed for. A player close to the camera
    has their feet at or below the bottom edge of the picture; treating the
    near baseline as the limit lost them, which read as "it loses players near
    the camera"."""
    poly = gate()
    assert inside(poly, 480, 539), "feet on the last row of pixels"
    assert inside(poly, 480, 700), "feet below the frame entirely"


def test_the_margin_allows_for_standing_just_outside_the_lines():
    """A player returning a wide ball stands off the court. The margin is why
    they are not deleted for it."""
    poly = gate()
    just_wide = QUAD[0][0] - (QUAD[1][0] - QUAD[0][0]) * 0.10   # 10% out, margin is 15%
    assert inside(poly, just_wide, 505)


def test_no_court_means_no_gate_rather_than_an_empty_one():
    """The important negative. With no court geometry the honest answer is
    "cannot judge", so every detection is kept -- an empty polygon would
    silently delete every player instead."""
    class NoCorners:
        pass
    assert _player_gate_polygon(NoCorners(), Config(), IMAGE) is None


def test_a_court_with_non_finite_corners_is_refused():
    class Broken:
        corners_px = np.array([[np.nan, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]])
    assert _player_gate_polygon(Broken(), Config(), IMAGE) is None
