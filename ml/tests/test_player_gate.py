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


# ---------------------------------------------------------------------------
# The STRICT gate: who counts as PLAYING, rather than who counts as on court.
#
# Reported from a night clip where the rally was at the far end: the two boxes
# on the setup frame landed on two men standing by the near fence with drinks.
# The loose gate above admitted them -- correctly, by its own rules, because it
# runs to 1.6x the image height so a player at the camera is not lost -- and
# they were larger, sharper and more confidently detected than four players at
# the far baseline, so they took every slot.
# ---------------------------------------------------------------------------

from rally_seg.pipeline import _player_gate_polygon_strict


def strict_gate():
    court = CourtModel.from_corners(QUAD, IMAGE)
    return _player_gate_polygon_strict(court, Config(), IMAGE)


def test_strict_gate_keeps_players_standing_on_the_paint():
    poly = strict_gate()
    assert inside(poly, 480, 400), "mid court"
    assert inside(poly, 480, 200), "near the far baseline"
    assert inside(poly, 480, 300), "the middle of the court"


def test_strict_gate_allows_a_little_room_behind_each_baseline():
    # A serve is struck from behind the baseline, so a hard edge on the paint
    # would drop the server on exactly the frame most worth showing.
    poly = strict_gate()
    assert inside(poly, 480, 520), "a step behind the near baseline"
    assert inside(poly, 480, 140), "a step behind the far baseline"


def test_strict_gate_rejects_somebody_standing_near_the_camera():
    # THE REPORTED BUG. The loose gate's wedge is at its widest nearest the
    # camera, which is exactly where the people NOT playing stand.
    loose = gate()
    poly = strict_gate()
    fence_x, fence_y = 870, 700   # off to one side, below the near baseline
    assert inside(loose, fence_x, fence_y), "the loose gate admits them, as designed"
    assert not inside(poly, fence_x, fence_y), "the strict gate must not"


def test_strict_gate_is_a_subset_of_the_loose_one():
    # If it were not, the strict pass could promote somebody the loose gate had
    # already thrown out -- which would put a spectator ahead of a player.
    loose, poly = gate(), strict_gate()
    rng = np.random.default_rng(7)
    pts = rng.uniform([0, 0], [IMAGE[0], IMAGE[1] * 1.5], size=(4000, 2))
    for x, y in pts:
        if inside(poly, x, y):
            assert inside(loose, x, y), f"({x:.0f},{y:.0f}) is strict-but-not-loose"


def test_strict_gate_is_meaningfully_tighter():
    # A guard against the margin being widened until the two gates agree,
    # which would silently restore the bug while leaving every other test green.
    loose, poly = gate(), strict_gate()
    rng = np.random.default_rng(11)
    pts = rng.uniform([0, 0], [IMAGE[0], IMAGE[1] * 1.5], size=(4000, 2))
    in_loose = sum(1 for x, y in pts if inside(loose, x, y))
    in_strict = sum(1 for x, y in pts if inside(poly, x, y))
    assert in_strict < in_loose * 0.6, (
        f"strict admits {in_strict} of the area the loose gate's {in_loose} does "
        "-- that is not tight enough to exclude the near-camera crowd"
    )


def test_strict_gate_is_none_without_a_court():
    # No court fitted means nothing to be inside of, and the caller falls back
    # to the loose set rather than dropping everybody.
    class NoCorners:
        pass
    assert _player_gate_polygon_strict(NoCorners(), Config(), IMAGE) is None


def test_the_fence_is_rejected_at_the_configured_margin():
    """The reported position, tested against the margin as shipped.

    A separate check from the one above because that one uses the default
    Config; this one says out loud that the DEFAULT is what has to reject it.
    The exact value of court_margin_strict_frac is a tunable and widening it
    somewhat would still be correct -- what must not change is that the two men
    at the near fence fall outside whatever it is set to.
    """
    cfg = Config()
    assert cfg.players.court_margin_strict_frac < cfg.players.court_margin_frac, (
        "the strict margin must be tighter than the following margin, or the "
        "two gates agree and the near-camera crowd comes back"
    )
    court = CourtModel.from_corners(QUAD, IMAGE)
    poly = _player_gate_polygon_strict(court, cfg, IMAGE)
    for x, y in [(870, 700), (910, 710), (60, 640), (880, 560)]:
        assert not inside(poly, x, y), f"({x},{y}) is off the court and must be rejected"
