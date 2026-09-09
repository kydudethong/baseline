"""End-to-end, on a generated clip with exact labels.

Runs the whole stack -- decode, court fit, tracking, events, state machine --
against a replayed detection stream that behaves like a well-trained but
imperfect YOLO (8% misses, occasional false positives, sub-pixel noise).  The
thresholds below are regression guards, not targets: they are set a little under
what the pipeline currently achieves, so an accuracy regression fails the build
while ordinary noise does not.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

from rally_seg.config import load_config
from rally_seg.evaluate import evaluate, load_ground_truth
from rally_seg.models.rule_based import RuleBasedSegmenter
from rally_seg.pipeline import build_features, segment_video

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
VIDEO = os.path.join(ROOT, "assets", "synthetic.mp4")
LABELS = os.path.join(ROOT, "assets", "synthetic.labels.json")
DETECTIONS = os.path.join(ROOT, "assets", "synthetic.detections.json")


@pytest.fixture(scope="module")
def clip():
    if not os.path.exists(VIDEO):
        subprocess.run([sys.executable, os.path.join(HERE, "make_synthetic.py"),
                        "--out", VIDEO, "--labels", LABELS, "--duration", "90"],
                       check=True, cwd=ROOT)
    return VIDEO


@pytest.fixture(scope="module")
def cfg():
    return load_config(None, {
        "ball.backend": "replay",
        "ball.replay_path": DETECTIONS,
        "players.backend": "motion",
        "cache_dir": os.path.join(ROOT, ".rally_cache"),
    })


@pytest.fixture(scope="module")
def stream(clip, cfg):
    st, info = build_features(clip, cfg, use_cache=True)
    return st, info


def test_court_is_fitted(stream):
    _st, info = stream
    assert info["court_detected"]
    assert info["court_confidence"] > 0.35


def test_perception_sees_the_ball_whenever_it_is_in_play(stream):
    st, info = stream
    # The ball only exists during rallies plus a short settle, so a detection
    # rate near the play fraction is the right shape of number.
    assert 0.25 < info["ball_detection_rate"] < 0.85


def test_all_rallies_are_found_with_correct_boundaries(clip, cfg, stream):
    st, _info = stream
    truth = load_ground_truth(LABELS)
    segments = RuleBasedSegmenter(cfg.state).segment(st)
    report = evaluate(segments, truth)

    assert report.f1 >= 0.85, report.summary()
    assert report.recall >= 0.85, report.summary()
    assert report.mean_iou >= 0.72, report.summary()
    assert report.over_segmentation <= 0.30, report.summary()
    assert report.under_segmentation <= 0.30, report.summary()
    assert report.start_median_s <= 0.6, report.summary()
    assert report.end_median_s <= 1.0, report.summary()
    assert report.boundary_f1["1.0"] >= 0.80, report.summary()
    assert report.leakage <= 0.20, report.summary()


def test_rallies_carry_measured_content(clip, cfg, stream):
    st, _info = stream
    segments = RuleBasedSegmenter(cfg.state).segment(st)
    assert segments
    for r in segments:
        assert r.net_crossings >= 1 or r.shots >= 3
        assert 0.0 <= r.confidence <= 1.0
        assert r.clip_start_s <= r.start_s and r.clip_end_s >= r.end_s
        assert r.evidence, "every boundary must be able to explain itself"


def test_result_serialises(clip, cfg):
    result, _st = segment_video(clip, cfg, use_cache=True)
    payload = json.loads(result.to_json())
    assert payload["schema_version"]
    assert payload["rally_count"] == len(payload["rallies"])
    assert 0.0 < payload["play_fraction"] < 1.0
    assert payload["court_detected"] is True


def test_the_feature_cache_is_reused(clip, cfg):
    _st, first = build_features(clip, cfg, use_cache=True)
    _st2, second = build_features(clip, cfg, use_cache=True)
    assert second.get("cached") is True
    assert os.path.exists(second["cache_path"])


def test_tuning_a_threshold_does_not_invalidate_the_cache(clip, cfg):
    tuned = cfg.copy().override({"state.start_threshold": 0.41})
    assert tuned.perception_digest() == cfg.perception_digest()
