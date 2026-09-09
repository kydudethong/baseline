"""The temporal logic, tested without a video in sight.

Each test states what perception saw and asserts what the machine concluded.
The interesting ones are the occlusion pair: identical ball behaviour, opposite
player behaviour, opposite answers.  That distinction is the whole reason the
state machine exists rather than a threshold on "is there a ball".
"""

from __future__ import annotations

import pytest

from helpers import add_event, add_gap, add_idle, add_play, make_stream

from rally_seg.config import Config
from rally_seg.events import DOUBLE_BOUNCE, NET_CROSS, OUT_OF_BOUNDS, SERVE
from rally_seg.models.rule_based import RuleBasedSegmenter
from rally_seg.schema import EndReason, StartReason


def seg(stream, **overrides):
    cfg = Config()
    if overrides:
        cfg.override({f"state.{k}": v for k, v in overrides.items()})
    return RuleBasedSegmenter(cfg.state).segment(stream)


def test_plain_rally_is_found():
    s = make_stream(20.0)
    add_idle(s, 0.0, 4.0)
    add_play(s, 4.0, 12.0)
    add_event(s, NET_CROSS, 4.4, feature="ev_net_cross")
    add_event(s, OUT_OF_BOUNDS, 12.0, 0.95, {"outside_by_ft": 2.0}, feature="ev_out")
    add_idle(s, 12.1, 20.0)

    out = seg(s)
    assert len(out) == 1
    assert out[0].end_reason is EndReason.OUT_OF_BOUNDS
    assert out[0].start_s == pytest.approx(4.0, abs=0.5)
    assert out[0].end_s == pytest.approx(12.0, abs=0.3)


def test_short_occlusion_does_not_split_a_rally():
    """The ball vanishes for 0.7 s while everyone keeps moving.  One rally."""
    s = make_stream(24.0)
    add_idle(s, 0.0, 3.0)
    add_play(s, 3.0, 8.0)
    add_gap(s, 8.0, 8.7, activity=0.5)        # occluded, players still working
    add_play(s, 8.7, 14.0)
    add_event(s, NET_CROSS, 3.4, feature="ev_net_cross")
    add_event(s, NET_CROSS, 9.0, feature="ev_net_cross")
    add_event(s, DOUBLE_BOUNCE, 14.0, 0.9, feature="ev_double_bounce")
    add_idle(s, 14.1, 24.0)

    out = seg(s)
    assert len(out) == 1, [(r.start_s, r.end_s, r.end_reason.value) for r in out]
    assert out[0].start_s < 4.0 and out[0].end_s > 13.0


def test_long_quiet_gap_ends_the_rally():
    """Same ball behaviour, but the players stop.  That is a rally ending."""
    s = make_stream(24.0)
    add_idle(s, 0.0, 3.0)
    add_play(s, 3.0, 8.0)
    add_gap(s, 8.0, 12.0, activity=0.02)      # ball gone, court gone quiet
    add_idle(s, 12.0, 24.0)
    add_event(s, NET_CROSS, 3.4, feature="ev_net_cross")

    out = seg(s)
    assert len(out) == 1
    assert out[0].end_reason in (EndReason.LOW_ACTIVITY, EndReason.OCCLUSION_TIMEOUT)
    assert out[0].end_s == pytest.approx(8.0, abs=1.0)


def test_occlusion_budget_is_conditioned_on_activity():
    """A gap longer than the quiet budget but shorter than the busy one."""
    cfg = Config()
    gap = 0.5 * (cfg.state.quiet_ball_gap_s + cfg.state.max_ball_gap_s)

    def build(activity):
        s = make_stream(20.0)
        add_idle(s, 0.0, 2.0)
        add_play(s, 2.0, 7.0)
        add_gap(s, 7.0, 7.0 + gap, activity=activity)
        add_play(s, 7.0 + gap, 11.0)
        add_event(s, NET_CROSS, 2.4, feature="ev_net_cross")
        add_event(s, NET_CROSS, 8.0, feature="ev_net_cross")
        add_idle(s, 11.1, 20.0)
        return s

    busy = seg(build(0.5))
    quiet = seg(build(0.02))
    assert len(busy) == 1, "a busy court should survive the gap as one rally"
    assert len(quiet) >= 1
    assert quiet[0].end_s < busy[0].end_s, "a quiet court should end at the gap"


def test_false_terminal_event_is_cancelled_when_play_resumes():
    """A spurious out-of-bounds mid-rally must not end it if the ball is still live."""
    s = make_stream(20.0)
    add_idle(s, 0.0, 2.0)
    add_play(s, 2.0, 12.0)
    add_event(s, NET_CROSS, 2.4, feature="ev_net_cross")
    add_event(s, OUT_OF_BOUNDS, 6.0, 0.8, {"outside_by_ft": 1.0}, feature="ev_out")
    add_event(s, NET_CROSS, 6.2, 0.9, feature="ev_net_cross")     # play visibly resumes
    add_event(s, DOUBLE_BOUNCE, 12.0, 0.9, feature="ev_double_bounce")
    add_idle(s, 12.1, 20.0)

    out = seg(s)
    assert len(out) == 1
    assert out[0].end_s == pytest.approx(12.0, abs=0.3)
    assert out[0].end_reason is EndReason.BALL_GROUNDED


def test_terminal_event_commits_when_play_does_not_resume():
    s = make_stream(20.0)
    add_idle(s, 0.0, 2.0)
    add_play(s, 2.0, 8.0)
    add_event(s, NET_CROSS, 2.4, feature="ev_net_cross")
    add_event(s, OUT_OF_BOUNDS, 6.0, 0.9, {"outside_by_ft": 3.0}, feature="ev_out")
    add_idle(s, 6.5, 20.0)

    out = seg(s)
    assert len(out) == 1
    assert out[0].end_reason is EndReason.OUT_OF_BOUNDS
    assert out[0].end_s == pytest.approx(6.0, abs=0.2)


def test_two_rallies_are_not_merged_across_a_decisive_ending():
    s = make_stream(30.0)
    add_idle(s, 0.0, 2.0)
    add_play(s, 2.0, 8.0)
    add_event(s, NET_CROSS, 2.4, feature="ev_net_cross")
    add_event(s, OUT_OF_BOUNDS, 8.0, 0.95, {"outside_by_ft": 4.0}, feature="ev_out")
    add_idle(s, 8.2, 12.0)
    add_play(s, 12.0, 18.0)
    add_event(s, NET_CROSS, 12.4, feature="ev_net_cross")
    add_event(s, DOUBLE_BOUNCE, 18.0, 0.9, feature="ev_double_bounce")
    add_idle(s, 18.2, 30.0)

    out = seg(s)
    assert len(out) == 2
    assert out[0].end_s < out[1].start_s


def test_rearm_hysteresis_prevents_an_instant_restart():
    """After a rally, leftover windowed evidence must not open a second one."""
    s = make_stream(20.0)
    add_idle(s, 0.0, 2.0)
    add_play(s, 2.0, 8.0)
    add_event(s, NET_CROSS, 2.4, feature="ev_net_cross")
    add_event(s, OUT_OF_BOUNDS, 8.0, 0.95, {"outside_by_ft": 4.0}, feature="ev_out")
    # Evidence decays slowly rather than stopping dead, as it does in reality.
    i0, i1 = s.index_at(8.0), s.index_at(10.0)
    from rally_seg.features import FEATURE_INDEX
    s.X[i0:i1, FEATURE_INDEX["rate_contact"]] = 1.2
    s.X[i0:i1, FEATURE_INDEX["rate_net_cross"]] = 0.6
    s.X[i0:i1, FEATURE_INDEX["player_activity_w"]] = 0.35
    add_idle(s, 10.0, 20.0)

    out = seg(s)
    assert len(out) == 1, [(r.start_s, r.end_s) for r in out]


def test_next_serve_ends_the_previous_rally_and_opens_the_next():
    s = make_stream(40.0)
    add_idle(s, 0.0, 2.0)
    add_play(s, 2.0, 9.0)
    add_event(s, NET_CROSS, 2.4, feature="ev_net_cross")
    add_play(s, 9.0, 16.0)
    add_event(s, SERVE, 9.0, 0.9, feature="ev_serve")
    add_event(s, NET_CROSS, 9.6, feature="ev_net_cross")
    add_event(s, DOUBLE_BOUNCE, 16.0, 0.9, feature="ev_double_bounce")
    add_idle(s, 16.2, 40.0)

    out = seg(s)
    assert len(out) == 2
    assert out[0].end_reason is EndReason.NEXT_SERVE
    assert out[1].start_reason is StartReason.SERVE_DETECTED
    assert out[1].start_s == pytest.approx(9.0, abs=0.4)


def test_spans_without_play_evidence_are_discarded():
    """Movement alone is not a rally: the ball has to go over the net."""
    s = make_stream(20.0)
    add_idle(s, 0.0, 2.0)
    add_play(s, 2.0, 9.0, cross_rate=0.0, contact_rate=0.0)
    add_idle(s, 9.0, 20.0)
    assert seg(s) == []


def test_min_and_max_duration_are_enforced():
    s = make_stream(200.0)
    add_idle(s, 0.0, 2.0)
    add_play(s, 2.0, 2.6)                       # too short to be a rally
    add_event(s, NET_CROSS, 2.3, feature="ev_net_cross")
    add_idle(s, 2.6, 6.0)
    add_play(s, 6.0, 190.0)                     # implausibly long
    add_event(s, NET_CROSS, 6.4, feature="ev_net_cross")
    add_idle(s, 190.0, 200.0)

    out = seg(s)
    cfg = Config()
    assert all(r.duration_s >= cfg.state.min_rally_s for r in out)
    assert all(r.duration_s <= cfg.state.max_rally_s + 1e-6 for r in out)


def test_clip_bounds_are_padded_and_measured_bounds_are_not():
    s = make_stream(20.0)
    add_idle(s, 0.0, 3.0)
    add_play(s, 3.0, 10.0)
    add_event(s, NET_CROSS, 3.4, feature="ev_net_cross")
    add_event(s, OUT_OF_BOUNDS, 10.0, 0.95, {"outside_by_ft": 3.0}, feature="ev_out")
    add_idle(s, 10.2, 20.0)

    cfg = Config()
    out = seg(s)
    assert len(out) == 1
    r = out[0]
    assert r.clip_start_s == pytest.approx(max(0.0, r.start_s - cfg.state.lead_s), abs=1e-6)
    assert r.clip_end_s == pytest.approx(r.end_s + cfg.state.tail_s, abs=1e-6)


def test_confidence_is_lower_when_the_ball_was_barely_seen():
    def build(coverage_speed):
        s = make_stream(20.0)
        add_idle(s, 0.0, 2.0)
        add_play(s, 2.0, 10.0, speed=coverage_speed)
        if coverage_speed < 0.5:
            # Ball flickers in and out: half the frames have no observation.
            from rally_seg.features import FEATURE_INDEX
            i0, i1 = s.index_at(2.0), s.index_at(10.0)
            s.X[i0:i1:2, FEATURE_INDEX["ball_observed"]] = 0.0
        add_event(s, NET_CROSS, 2.4, feature="ev_net_cross")
        add_event(s, OUT_OF_BOUNDS, 10.0, 0.95, {"outside_by_ft": 3.0}, feature="ev_out")
        add_idle(s, 10.2, 20.0)
        return seg(s)

    clean, flaky = build(0.9), build(0.3)
    assert clean and flaky
    assert flaky[0].confidence < clean[0].confidence


def test_an_evidence_free_ending_snaps_back_to_the_last_live_play():
    """When nothing terminates the rally, the boundary follows the ball, not the score."""
    s = make_stream(30.0)
    add_idle(s, 0.0, 2.0)
    add_play(s, 2.0, 9.0)
    add_event(s, NET_CROSS, 2.4, feature="ev_net_cross")
    add_event(s, NET_CROSS, 8.6, feature="ev_net_cross")
    # The ball is still tracked afterwards -- it is lying on the court -- but it
    # is not moving, and nobody is playing it.
    from rally_seg.features import FEATURE_INDEX
    i0, i1 = s.index_at(9.0), s.index_at(13.0)
    s.X[i0:i1, FEATURE_INDEX["ball_present"]] = 1.0
    s.X[i0:i1, FEATURE_INDEX["ball_observed"]] = 1.0
    s.X[i0:i1, FEATURE_INDEX["ball_speed"]] = 0.03
    s.X[i0:i1, FEATURE_INDEX["player_activity_w"]] = 0.05
    add_idle(s, 13.0, 30.0)

    out = seg(s)
    assert len(out) == 1
    assert out[0].end_s == pytest.approx(9.0, abs=0.6), (
        "the rally ended when the ball did, not when the score decayed"
    )
