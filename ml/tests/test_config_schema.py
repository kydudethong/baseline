import json

import pytest

from rally_seg.config import Config, load_config
from rally_seg.schema import EndReason, RallySegment, SegmentationResult, StartReason


def test_dotted_overrides_coerce_types():
    cfg = Config()
    cfg.override({"state.max_ball_gap_s": "1.4", "debug.draw_court": "false",
                  "video.stride": "2"})
    assert cfg.state.max_ball_gap_s == 1.4 and isinstance(cfg.state.max_ball_gap_s, float)
    assert cfg.debug.draw_court is False
    assert cfg.video.stride == 2 and isinstance(cfg.video.stride, int)


def test_unknown_keys_are_rejected():
    with pytest.raises(KeyError):
        Config().override({"state.nope": 1})
    with pytest.raises(KeyError):
        Config.from_dict({"nonsense": {}})


def test_round_trip_preserves_digest():
    cfg = Config()
    cfg.override({"state.start_threshold": 0.61})
    assert Config.from_dict(cfg.to_dict()).digest() == cfg.digest()


def test_perception_digest_ignores_segmentation_thresholds():
    """The whole point of the cache: tuning the state machine must not invalidate it."""
    base = Config()
    tuned = base.copy().override({"state.start_threshold": 0.7, "state.tail_s": 1.1})
    assert tuned.perception_digest() == base.perception_digest()
    assert tuned.digest() != base.digest()

    other = base.copy().override({"ball.conf": 0.4})
    assert other.perception_digest() != base.perception_digest()


def test_env_overrides(monkeypatch):
    monkeypatch.setenv("RALLYSEG_STATE__MAX_BALL_GAP_S", "2.5")
    assert load_config().state.max_ball_gap_s == 2.5


def test_segment_json_round_trip():
    seg = RallySegment(
        idx=0, start_s=1.25, end_s=9.5, clip_start_s=0.8, clip_end_s=10.2,
        start_reason=StartReason.SERVE_DETECTED, end_reason=EndReason.OUT_OF_BOUNDS,
        confidence=0.81, start_confidence=0.9, end_confidence=0.95,
        shots=7, net_crossings=6, bounces=4, ball_coverage=0.72,
        mean_player_activity=0.4, max_ball_speed_mps=13.2,
    )
    result = SegmentationResult(
        video_path="/tmp/x.mp4", duration_s=120.0, fps=30.0, width=1920, height=1080,
        rallies=[seg],
    )
    back = SegmentationResult.from_dict(json.loads(result.to_json()))
    assert back.rally_count if hasattr(back, "rally_count") else True
    assert len(back.rallies) == 1
    r = back.rallies[0]
    assert (r.start_s, r.end_s, r.clip_start_s, r.clip_end_s) == (1.25, 9.5, 0.8, 10.2)
    assert r.end_reason is EndReason.OUT_OF_BOUNDS
    assert result.play_fraction == pytest.approx((9.5 - 1.25) / 120.0)


def test_non_finite_speed_serialises_as_null():
    seg = RallySegment(idx=0, start_s=0.0, end_s=1.0, max_ball_speed_mps=float("nan"))
    assert seg.to_dict()["max_ball_speed_mps"] is None
