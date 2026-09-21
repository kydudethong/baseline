"""Who gets the four boxes on the setup frame.

The ordering, not the geometry -- test_player_gate covers the polygons. This
covers the thing that actually went wrong on Ky's night clip: every detection
passed the loose gate, so the ranking was pure confidence, and confidence is
very nearly a measure of how close somebody is to the camera.
"""
import numpy as np
import pytest

from rally_seg.cli import _frame_setup_score


class Det:
    """The fields _frame_setup_score reads off a detection."""
    def __init__(self, x, y, h, conf):
        self.x1, self.x2 = x - h * 0.2, x + h * 0.2
        self.y1, self.y2 = y - h, y
        self.feet = (x, y)
        self.conf = conf


class FakeCourt:
    """Near half is below the halfway line, far half above it."""
    def __init__(self, net_y=320.0):
        self.net_y = net_y

    def to_court(self, pts):
        return np.asarray(pts, dtype=float)

    def side_of_net(self, pt):
        return -1.0 if pt[1] > self.net_y else 1.0


def test_four_on_court_beats_two_on_court_plus_two_bystanders():
    """THE REPORTED FRAME.

    Two men at the near fence, detected at 0.95 because they are close and
    still, plus two players at the far baseline at 0.35 because they are small
    and moving. Against a frame with four real players, all far, all faint.
    """
    court = FakeCourt()
    bystanders = [Det(860, 700, 260, 0.95), Det(910, 710, 260, 0.93)]
    two_players = [Det(300, 200, 60, 0.35), Det(560, 210, 60, 0.33)]
    mixed = bystanders + two_players

    four_players = [Det(300, 200, 60, 0.35), Det(560, 210, 60, 0.33),
                    Det(340, 430, 90, 0.40), Det(600, 440, 90, 0.38)]

    mixed_score = _frame_setup_score(mixed, court, on_court=two_players)
    good_score = _frame_setup_score(four_players, court, on_court=four_players)
    assert good_score > mixed_score, (
        "a frame with four players on court must beat one with two players and "
        "two confident bystanders"
    )


def test_the_count_is_taken_over_who_is_on_court_not_who_was_detected():
    """The specific mechanism. Four detections, only two of them playing."""
    court = FakeCourt()
    dets = [Det(300, 200, 60, 0.4), Det(560, 210, 60, 0.4),
            Det(860, 700, 260, 0.9), Det(910, 710, 260, 0.9)]
    on_court = dets[:2]
    counted_all = _frame_setup_score(dets, court, on_court=dets)
    counted_real = _frame_setup_score(dets, court, on_court=on_court)
    assert counted_real < counted_all, (
        "scoring 4-on-court the same as 2-on-court is what let the bad frame win"
    )


def test_confidence_cannot_outweigh_a_missing_player():
    """A frame one player short must lose however sharp its detections are.

    The count term is 3.0 per player away from four and confidence is bounded
    at 1.0, so the arithmetic cannot be talked round. One player short is the
    tightest case: three short would pass on any weighting and prove nothing.
    """
    court = FakeCourt()
    three_crisp = [Det(300, 200, 60, 1.0), Det(560, 210, 60, 1.0),
                   Det(340, 430, 90, 1.0)]
    four_faint = [Det(300, 200, 60, 0.01), Det(560, 210, 60, 0.01),
                  Det(340, 430, 90, 0.01), Det(600, 440, 90, 0.01)]
    assert (_frame_setup_score(four_faint, court, on_court=four_faint)
            > _frame_setup_score(three_crisp, court, on_court=three_crisp))


def test_two_a_side_beats_all_four_on_one_side():
    """Four detections on one side is usually two players and two spectators."""
    court = FakeCourt()
    split = [Det(300, 200, 60, 0.5), Det(560, 210, 60, 0.5),
             Det(340, 430, 90, 0.5), Det(600, 440, 90, 0.5)]
    lopsided = [Det(300, 200, 60, 0.5), Det(560, 210, 60, 0.5),
                Det(340, 180, 60, 0.5), Det(600, 190, 60, 0.5)]
    assert (_frame_setup_score(split, court, on_court=split)
            > _frame_setup_score(lopsided, court, on_court=lopsided))


def test_overlapping_boxes_are_still_penalised():
    """A click has to be unambiguous, which was already true and must stay so."""
    court = FakeCourt()
    apart = [Det(200, 430, 90, 0.5), Det(600, 440, 90, 0.5),
             Det(300, 200, 60, 0.5), Det(560, 210, 60, 0.5)]
    stacked = [Det(200, 430, 90, 0.5), Det(205, 435, 90, 0.5),
               Det(300, 200, 60, 0.5), Det(560, 210, 60, 0.5)]
    assert (_frame_setup_score(apart, court, on_court=apart)
            > _frame_setup_score(stacked, court, on_court=stacked))


def test_on_court_defaults_to_every_detection():
    """Callers without a court (nothing to be inside of) still get a score."""
    court = FakeCourt()
    dets = [Det(300, 200, 60, 0.5), Det(560, 210, 60, 0.5)]
    assert _frame_setup_score(dets, court) == _frame_setup_score(dets, court, on_court=dets)


def test_an_empty_frame_does_not_crash_and_scores_badly():
    assert _frame_setup_score([], None) == pytest.approx(-12.0)
