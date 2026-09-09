"""Ball tracking and event extraction, driven by synthetic trajectories."""

from __future__ import annotations

import numpy as np
import pytest

from rally_seg.config import BallTrackConfig, EventConfig
from rally_seg.detect.ball import Detection, _nms, _tiles
from rally_seg.detect.court import CourtModel
from rally_seg.events import BOUNCE, OUT_OF_BOUNDS, PADDLE_CONTACT, EventDetector
from rally_seg.track.ball_track import BallTracker
from rally_seg.track.bytetrack import PlayerTracker, iou_matrix
from rally_seg.detect.players import BoxDetection
from rally_seg.config import TrackerConfig

FPS = 30.0
QUAD = np.array([[150.0, 505.0], [810.0, 505.0], [612.0, 150.0], [348.0, 150.0]],
                dtype=np.float32)


def court():
    return CourtModel.from_corners(QUAD, (960, 540))


def parabola(n=40, x0=200.0, vx=12.0, y0=400.0, vy=-30.0, g=3.0):
    """A ball in free flight, in image pixels per frame."""
    return [(x0 + vx * i, y0 + vy * i + 0.5 * g * i * i) for i in range(n)]


# --- ball tracker -------------------------------------------------------------


def test_tracker_follows_a_parabola():
    tr = BallTracker(BallTrackConfig(), FPS)
    state = None
    for i, (x, y) in enumerate(parabola()):
        state = tr.update([Detection(x, y, 0.9, 8, 8)], i / FPS, i)
    assert state.present and state.observed
    assert state.xy[0] == pytest.approx(parabola()[-1][0], abs=6.0)


def test_a_dropout_reports_no_ball_rather_than_a_guess():
    """Default: a frame where the ball was not seen reports no ball.

    The track survives internally so the ball is reacquired immediately, but the
    filter's prediction is not handed downstream dressed as a measurement --
    nothing further down the pipeline could tell the difference.
    """
    tr = BallTracker(BallTrackConfig(), FPS)
    pts = parabola(40)
    dropped_states = []
    for i, (x, y) in enumerate(pts):
        dropped = 12 <= i < 16
        state = tr.update([] if dropped else [Detection(x, y, 0.9, 8, 8)], i / FPS, i)
        if dropped:
            dropped_states.append(state)
    assert len(dropped_states) == 4
    assert not any(s.present for s in dropped_states)
    assert not any(s.observed for s in dropped_states)
    assert all(s.xy is None for s in dropped_states)
    # ...and the ball is picked straight back up, from the same track.
    assert state.observed and state.present


def test_the_track_survives_the_dropout_and_is_not_restarted():
    """Reacquisition must reuse the track, not start a new one.

    A new track would have to earn `min_hits` again, so the ball would go
    missing for several more frames after it was already visible again.
    """
    tr = BallTracker(BallTrackConfig(), FPS)
    pts = parabola(40)
    before = after = None
    for i, (x, y) in enumerate(pts):
        dropped = 12 <= i < 16
        state = tr.update([] if dropped else [Detection(x, y, 0.9, 8, 8)], i / FPS, i)
        if i == 11:
            before = state.track_id
        if i == 16:
            after = state.track_id
    assert before is not None and before == after


def test_predicted_positions_can_be_reported_when_asked():
    cfg = BallTrackConfig(report_predicted_positions=True)
    tr = BallTracker(cfg, FPS)
    pts = parabola(40)
    coasted = 0
    for i, (x, y) in enumerate(pts):
        dropped = 12 <= i < 16
        state = tr.update([] if dropped else [Detection(x, y, 0.9, 8, 8)], i / FPS, i)
        if dropped:
            assert state.present and not state.observed
            assert state.xy is not None
            coasted += 1
    assert coasted == 4


def test_track_dies_after_the_coast_limit():
    cfg = BallTrackConfig(max_coast_frames=5)
    tr = BallTracker(cfg, FPS)
    for i, (x, y) in enumerate(parabola(12)):
        tr.update([Detection(x, y, 0.9, 8, 8)], i / FPS, i)
    state = None
    for k in range(12):
        state = tr.update([], (12 + k) / FPS, 12 + k)
    assert not state.present


def test_a_distractor_does_not_steal_the_track():
    """A second blob wandering nearby must not capture the confirmed track."""
    tr = BallTracker(BallTrackConfig(), FPS)
    state = None
    for i, (x, y) in enumerate(parabola(40)):
        dets = [Detection(x, y, 0.9, 8, 8)]
        if i > 5:
            dets.append(Detection(600.0 + 0.2 * i, 300.0, 0.5, 9, 9))   # a shoe
        state = tr.update(dets, i / FPS, i)
    assert state.xy[0] == pytest.approx(parabola(40)[-1][0], abs=12.0)


# --- events -------------------------------------------------------------------


def run_events(points, cfg=None, players=(), court_model=None):
    ev = EventDetector(cfg or EventConfig(), court_model or court(), FPS, (960, 540))
    tr = BallTracker(BallTrackConfig(), FPS)
    out = []
    for i, (x, y) in enumerate(points):
        state = tr.update([Detection(x, y, 0.9, 8, 8)], i / FPS, i)
        out.extend(ev.update(state, players, i / FPS, i))
    return out


def test_bounce_is_found_even_when_image_y_never_peaks():
    """A ball travelling toward the camera keeps moving down the frame across a bounce.

    This is the case that a "local maximum of image y" rule silently loses, and
    with it every out-of-bounds call.
    """
    pts = []
    # Descending toward the camera: ground point sweeps down fast.
    for i in range(14):
        pts.append((300.0 + 6.0 * i, 260.0 + 9.0 * i + 0.9 * i * i))
    x_b, y_b = pts[-1]
    # After the bounce the ball rises relative to the ground, but the ground is
    # still sweeping down, so image y keeps increasing -- just more slowly.
    for i in range(1, 16):
        pts.append((x_b + 6.0 * i, y_b + 2.0 * i + 0.3 * i * i))
    kinds = [e.kind for e in run_events(pts)]
    assert BOUNCE in kinds


def test_free_flight_produces_no_impulse():
    """Gravity alone must never look like a strike."""
    kinds = [e.kind for e in run_events(parabola(45, g=3.5))]
    assert BOUNCE not in kinds and PADDLE_CONTACT not in kinds


def test_direction_reversal_reads_as_a_paddle_contact():
    pts = [(500.0 - 14.0 * i, 300.0 - 6.0 * i + 0.4 * i * i) for i in range(12)]
    x, y = pts[-1]
    pts += [(x + 16.0 * i, y - 8.0 * i + 0.4 * i * i) for i in range(1, 14)]
    kinds = [e.kind for e in run_events(pts)]
    assert PADDLE_CONTACT in kinds


def bounce_at(m, court_pt):
    """Frames for a ball falling onto ``court_pt`` and kicking up again.

    Horizontal velocity is deliberately unchanged across the turn: the court
    cannot push the ball sideways, and that is exactly what separates a bounce
    from a paddle in the classifier.
    """
    landing = m.to_image(np.array([court_pt], dtype=np.float32))[0]
    vx = 5.0
    pts = [(landing[0] - vx * (14 - i), landing[1] - 26.0 * (14 - i) + 1.2 * (14 - i) ** 2)
           for i in range(14)]
    pts += [(landing[0] + vx * i, landing[1] - 14.0 * i + 0.8 * i * i) for i in range(1, 14)]
    return pts


def test_a_bounce_outside_the_lines_is_called_out():
    m = court()
    pts = bounce_at(m, (26.0, 20.0))
    events = run_events(pts, court_model=m)
    kinds = [e.kind for e in events]
    assert BOUNCE in kinds
    assert OUT_OF_BOUNDS in kinds
    out = next(e for e in events if e.kind == OUT_OF_BOUNDS)
    assert out.detail["outside_by_ft"] > 0.6


def test_a_bounce_inside_the_lines_is_not_called_out():
    m = court()
    pts = bounce_at(m, (10.0, 20.0))
    kinds = [e.kind for e in run_events(pts, court_model=m)]
    assert OUT_OF_BOUNDS not in kinds


# --- players ------------------------------------------------------------------


def test_player_tracker_keeps_identity_through_a_low_score_stretch():
    tr = PlayerTracker(TrackerConfig())
    ids = []
    for i in range(40):
        conf = 0.2 if 12 <= i < 18 else 0.9      # a half-occluded stretch
        box = BoxDetection(100.0 + 2 * i, 200.0, 140.0 + 2 * i, 320.0, conf)
        tracks = tr.update([box])
        if tracks:
            ids.append(tracks[0].id)
    assert len(set(ids)) == 1, "identity churn would look like an activity spike"


def test_iou_matrix_matches_by_hand():
    a = np.array([[0.0, 0.0, 10.0, 10.0]])
    b = np.array([[5.0, 0.0, 15.0, 10.0], [0.0, 0.0, 10.0, 10.0]])
    m = iou_matrix(a, b)
    assert m[0, 0] == pytest.approx(50.0 / 150.0, abs=1e-4)
    assert m[0, 1] == pytest.approx(1.0, abs=1e-6)


# --- detector plumbing --------------------------------------------------------


def test_tiles_cover_the_whole_frame_with_overlap():
    img = np.zeros((540, 960, 3), np.uint8)
    crops, offsets = _tiles(img, 2, 2, 0.2)
    assert len(crops) == 4
    covered = np.zeros((540, 960), bool)
    for crop, (ox, oy) in zip(crops, offsets):
        covered[oy:oy + crop.shape[0], ox:ox + crop.shape[1]] = True
    assert covered.all()


def test_nms_merges_duplicates_and_keeps_distinct_balls():
    dets = [Detection(100, 100, 0.9, 10, 10), Detection(103, 101, 0.6, 10, 10),
            Detection(500, 300, 0.7, 10, 10)]
    kept = _nms(dets, 0.45)
    assert len(kept) == 2
    assert kept[0].conf == pytest.approx(0.9)


def test_nms_handles_zero_size_boxes():
    dets = [Detection(100, 100, 0.9), Detection(101, 100, 0.5)]
    assert len(_nms(dets, 0.45)) == 1
