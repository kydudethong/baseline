import numpy as np
import pytest

from rally_seg.detect.court import (
    COURT_CORNERS, COURT_W, NET_Y, CourtModel, FallbackCourt,
)

QUAD = np.array([[150.0, 505.0], [810.0, 505.0], [612.0, 150.0], [348.0, 150.0]],
                dtype=np.float32)


def model():
    return CourtModel.from_corners(QUAD, (960, 540))


def test_corners_round_trip():
    m = model()
    back = m.to_court(m.to_image(COURT_CORNERS))
    assert np.allclose(back, COURT_CORNERS, atol=1e-3)


def test_image_to_court_is_the_inverse():
    m = model()
    pts = np.array([[400.0, 400.0], [500.0, 300.0], [700.0, 480.0]])
    assert np.allclose(m.to_image(m.to_court(pts)), pts, atol=1e-3)


def test_bounds_and_side():
    m = model()
    assert m.is_in_bounds((10.0, 22.0))
    assert not m.is_in_bounds((-3.0, 22.0))
    assert m.is_in_bounds((-0.4, 22.0), margin_ft=0.6)
    assert m.side_of_net((10.0, 5.0)) == -1
    assert m.side_of_net((10.0, 40.0)) == 1


def test_perspective_scale_shrinks_with_distance():
    m = model()
    near = m.px_per_ft_at((COURT_W / 2, 1.0))
    far = m.px_per_ft_at((COURT_W / 2, 43.0))
    assert near > far > 0


def test_net_band_sits_above_the_net_line():
    m = model()
    top, base = m.net_band_px(480.0)
    assert top < base
    _p0, _p1 = m.net_line_px
    assert base == pytest.approx(m.to_image(np.array([[10.0, NET_Y]]))[0][1], abs=1.0)


def test_serialisation_round_trip():
    m = model()
    back = CourtModel.from_dict(m.to_dict())
    assert np.allclose(back.H, m.H)
    assert np.allclose(back.to_court(np.array([[480.0, 300.0]])),
                       m.to_court(np.array([[480.0, 300.0]])), atol=1e-6)


def test_fallback_reports_unavailable_rather_than_guessing():
    """A missing court must not silently produce plausible-looking coordinates."""
    fb = FallbackCourt((960, 540), 0.52)
    mapped = fb.to_court(np.array([[400.0, 300.0]]))
    assert np.all(np.isnan(mapped))
    top, base = fb.net_band_px(400.0)
    assert top < base


# --- the consensus gate ------------------------------------------------------
#
# The gate exists to reject a quad that one lucky frame scored well on. It must
# not reject a quad that several frames independently converged on and that
# explains most of the paint it predicts -- measured on real footage, the
# correct fit came in at 18% agreement (4 of 22 frames) with 0.63 line support,
# within 10px of hand-marked corners, and the old fraction-only gate threw it
# away.

def _detector_with(monkeypatch, fits):
    from rally_seg.config import CourtConfig
    from rally_seg.detect import court as C

    cfg = CourtConfig()
    it = iter(fits)
    monkeypatch.setattr(C, "fit_court_from_image", lambda _img, _cfg: next(it, None))
    return C.CourtDetector(cfg), cfg


def _fit(corners, conf):
    return CourtModel.from_corners(np.asarray(corners, dtype=np.float32), (960, 540), conf)


def test_minority_consensus_survives_when_line_support_is_strong(monkeypatch):
    """4 of 22 frames agreeing on a well-supported quad is evidence, not luck."""
    agreeing = [_fit(QUAD, 0.63) for _ in range(4)]
    # The rest fit *something else badly*, each in its own place, which is what
    # dilutes the agreement fraction without disagreeing about the court.
    others = [_fit(QUAD + np.float32(60 * (i + 1)), 0.60) for i in range(18)]
    det, _cfg = _detector_with(monkeypatch, agreeing + others)
    model_ = det.fit([np.zeros((540, 960, 3), np.uint8)] * 22, (960, 540))
    assert not isinstance(model_, FallbackCourt)
    assert model_.agreement < 0.20
    assert np.allclose(model_.corners_px, QUAD, atol=1.0)


def test_one_lucky_frame_is_still_rejected(monkeypatch):
    """The thing the gate is actually for: a single frame, however confident."""
    fits = [_fit(QUAD, 0.95)] + [_fit(QUAD + np.float32(60 * (i + 1)), 0.90) for i in range(19)]
    det, _cfg = _detector_with(monkeypatch, fits)
    model_ = det.fit([np.zeros((540, 960, 3), np.uint8)] * 20, (960, 540))
    assert isinstance(model_, FallbackCourt)
    assert det.last_rejection and "agreed" in det.last_rejection


def test_weak_support_still_needs_a_majority(monkeypatch):
    """Several frames agreeing on a quad that explains no paint is not enough."""
    fits = [_fit(QUAD, 0.20) for _ in range(3)] + \
           [_fit(QUAD + np.float32(60 * (i + 1)), 0.19) for i in range(17)]
    det, _cfg = _detector_with(monkeypatch, fits)
    assert isinstance(det.fit([np.zeros((540, 960, 3), np.uint8)] * 20, (960, 540)), FallbackCourt)
