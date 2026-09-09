import json

import numpy as np
import pytest

from helpers import add_event, add_play, make_stream

from rally_seg.calibrate import LabelledClip, calibrate, overrides_to_yaml
from rally_seg.config import Config
from rally_seg.evaluate import Interval, evaluate, iou, load_ground_truth, score_for_tuning
from rally_seg.features import FEATURE_NAMES, FEATURE_VERSION, N_FEATURES, FeatureStream
from rally_seg.schema import RallySegment


def s(a, b):
    return RallySegment(idx=0, start_s=a, end_s=b)


def test_perfect_prediction_scores_one():
    truth = [Interval(1, 5), Interval(10, 16)]
    rep = evaluate([s(1, 5), s(10, 16)], truth)
    assert rep.f1 == 1.0 and rep.mean_iou == pytest.approx(1.0)
    assert rep.start_mae_s == pytest.approx(0.0)
    assert rep.boundary_f1["0.25"] == pytest.approx(1.0)


def test_a_split_rally_is_counted_as_over_segmentation():
    truth = [Interval(0, 10)]
    rep = evaluate([s(0, 4.5), s(5.5, 10)], truth)
    assert rep.over_segmentation > 0
    assert rep.under_segmentation == 0


def test_a_merged_pair_is_counted_as_under_segmentation():
    truth = [Interval(0, 4), Interval(6, 10)]
    rep = evaluate([s(0, 10)], truth)
    assert rep.under_segmentation > 0


def test_late_boundaries_show_up_as_boundary_error_not_as_a_miss():
    truth = [Interval(0, 10)]
    rep = evaluate([s(0.8, 10.8)], truth)
    assert rep.f1 == 1.0                       # still matched on IoU
    assert rep.start_mae_s == pytest.approx(0.8, abs=1e-6)
    assert rep.boundary_f1["0.5"] == 0.0       # but the boundaries are wrong
    assert rep.boundary_f1["1.0"] == 1.0


def test_tuning_score_prefers_tight_boundaries():
    truth = [Interval(0, 10), Interval(15, 22)]
    tight = evaluate([s(0.05, 10.05), s(15.05, 22.05)], truth)
    loose = evaluate([s(0.9, 10.9), s(15.9, 22.9)], truth)
    assert score_for_tuning(tight) > score_for_tuning(loose)


def test_iou_of_disjoint_intervals_is_zero():
    assert iou(Interval(0, 1), Interval(2, 3)) == 0.0


def test_ground_truth_accepts_both_shapes(tmp_path):
    a = tmp_path / "a.json"
    a.write_text(json.dumps([{"start_s": 1, "end_s": 2}]))
    b = tmp_path / "b.json"
    b.write_text(json.dumps({"rallies": [{"start_s": 1, "end_s": 2}]}))
    assert load_ground_truth(str(a))[0].end_s == 2
    assert load_ground_truth(str(b))[0].end_s == 2


# --- feature stream -----------------------------------------------------------


def test_feature_names_are_unique_and_sized():
    assert len(set(FEATURE_NAMES)) == len(FEATURE_NAMES) == N_FEATURES


def test_feature_stream_round_trips(tmp_path):
    st = make_stream(5.0)
    add_play(st, 1.0, 3.0)
    add_event(st, "bounce", 2.0, 0.8, {"court_xy": [4.0, 12.0]})
    st.ball_xy = np.random.rand(len(st), 3).astype(np.float32)
    path = str(tmp_path / "f.npz")
    st.save(path)
    back = FeatureStream.load(path)
    assert np.allclose(back.X, st.X)
    assert np.allclose(back.ball_xy, st.ball_xy)
    assert [e.kind for e in back.events] == ["bounce"]
    assert back.events[0].detail["court_xy"] == [4.0, 12.0]


def test_a_stale_feature_cache_is_refused(tmp_path):
    st = make_stream(2.0)
    path = str(tmp_path / "f.npz")
    st.save(path)
    data = dict(np.load(path, allow_pickle=False))
    side = json.loads(bytes(data["sidecar"]).decode())
    side["feature_version"] = FEATURE_VERSION + 1
    data["sidecar"] = np.frombuffer(json.dumps(side).encode(), dtype=np.uint8)
    np.savez_compressed(path, **data)
    with pytest.raises(ValueError, match="feature_version"):
        FeatureStream.load(path)


# --- calibration --------------------------------------------------------------


def test_calibration_improves_a_deliberately_bad_config():
    st = make_stream(40.0)
    truth = []
    for start in (3.0, 14.0, 26.0):
        add_play(st, start, start + 6.0)
        add_event(st, "net_cross", start + 0.4, feature="ev_net_cross")
        add_event(st, "out_of_bounds", start + 6.0, 0.95,
                  {"outside_by_ft": 3.0}, feature="ev_out")
        truth.append(Interval(start, start + 6.0))

    bad = Config()
    bad.override({"state.start_threshold": 0.95})     # nothing can ever start
    clip = LabelledClip("synthetic", st, truth)
    result = calibrate(bad, [clip], passes=2, verbose=False)
    assert result.best_score > result.baseline_score
    assert "state.start_threshold" in result.best_overrides


def test_overrides_render_as_yaml():
    text = overrides_to_yaml({"state.start_threshold": 0.4, "state.tail_s": 0.9})
    assert "state:" in text and "start_threshold: 0.4" in text
