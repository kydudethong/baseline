"""The rule-based temporal segmenter.

A two-threshold state machine with gap tolerance.  The shape of it:

    IDLE ---- start evidence sustained for start_hold_frames ----> RALLY
    RALLY ---- a terminating event, or evidence decayed for stop_hold_frames ----> IDLE

Three things make this hold up on real footage rather than only on clean clips.

**Asymmetric thresholds.**  Starting costs more evidence than continuing.  A
single frame of ball-like noise during the dead time between points cannot open
a rally; a genuinely ambiguous mid-rally frame cannot close one.

**Gap tolerance, conditioned on the players.**  The ball disappears constantly --
behind a body, against a bright fence, past the detector on a hard drive.  The
machine tolerates ``max_ball_gap_s`` of that.  But if the ball is gone *and*
everyone has stopped moving, the much shorter ``quiet_ball_gap_s`` applies,
because that combination is what the end of a point actually looks like.  Ball
alone is ambiguous; ball plus bodies is not.

**Terminating events beat scores.**  A bounce mapped outside the sidelines, a
ball that dies in the net, a second bounce with no paddle in between, or the
next serve starting -- these end the rally immediately and set the boundary at
the event, not at the point where a smoothed score happened to sag.  The score
path is the fallback for endings the ball never showed you.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Optional, Tuple

import numpy as np

from ..config import StateMachineConfig
from ..events import (
    BALL_ROLL, BOUNCE, DOUBLE_BOUNCE, NET_CONTACT, NET_CROSS,
    OUT_OF_BOUNDS, PADDLE_CONTACT, SERVE, Event,
)
from ..features import FEATURE_INDEX, GAP_REFERENCE_S, FeatureStream
from ..schema import EndReason, Evidence, RallySegment, StartReason
from .base import RallySegmenter, postprocess

IDLE, RALLY, ENDING = 0, 1, 2

#: Normalised ball speed (px/s over frame height) below which the ball is not
#: meaningfully in play.  Used to decide whether a contact-shaped event during
#: the end-confirmation window really means the rally is continuing.
RESUME_MIN_BALL_SPEED = 0.35


def _noisy_or(terms) -> np.ndarray:
    """Fuse independent evidence.

    Each weight is read as "how convincing is this signal on its own, at full
    strength".  The combination is 1 - prod(1 - w*x), so evidence accumulates
    without any single source being capped by the presence of the others.
    """
    acc = None
    for weight, values in terms:
        contrib = np.clip(np.asarray(values, dtype=np.float64) * float(weight), 0.0, 0.985)
        acc = (1.0 - contrib) if acc is None else acc * (1.0 - contrib)
    return (1.0 - acc) if acc is not None else np.zeros(0, dtype=np.float64)


def _decay(x: np.ndarray, tau_frames: float) -> np.ndarray:
    """Exponential hold: ``y[i] = max(x[i], y[i-1] * alpha)``."""
    alpha = float(np.exp(-1.0 / max(1e-6, tau_frames)))
    y = np.empty_like(x, dtype=np.float32)
    running = 0.0
    for i in range(len(x)):
        running = max(float(x[i]), running * alpha)
        y[i] = running
    return y

#: Events that end a rally on their own, with the reason they map to and a
#: multiplier on the event's own confidence.
TERMINAL_EVENTS = {
    OUT_OF_BOUNDS: (EndReason.OUT_OF_BOUNDS, 1.00),
    NET_CONTACT: (EndReason.NET_CONTACT, 0.95),
    DOUBLE_BOUNCE: (EndReason.BALL_GROUNDED, 0.95),
    BALL_ROLL: (EndReason.BALL_GROUNDED, 0.85),
    SERVE: (EndReason.NEXT_SERVE, 0.90),
}


@dataclass
class Scores:
    start: np.ndarray
    end: np.ndarray
    occlusion: np.ndarray
    gap_s: np.ndarray


class RuleBasedSegmenter(RallySegmenter):
    name = "rule_based"

    def __init__(self, cfg: StateMachineConfig, trace: bool = False):
        self.cfg = cfg
        #: When enabled, every state transition is recorded here.  Reading the
        #: trace next to the debug video is how you find out *why* a boundary
        #: landed where it did, which is otherwise close to unknowable.
        self.trace_enabled = trace
        self.trace: List[str] = []

    def _log(self, t_s: float, message: str) -> None:
        if self.trace_enabled:
            self.trace.append(f"{t_s:8.3f}  {message}")

    # --- scoring -----------------------------------------------------------

    def scores(self, stream: FeatureStream) -> Scores:
        c = self.cfg
        X = stream.X
        n = len(stream)
        if n == 0:
            z = np.zeros(0, dtype=np.float32)
            return Scores(z, z, z, z)

        col = lambda name: X[:, FEATURE_INDEX[name]]
        tau_frames = max(1.0, c.evidence_decay_s * (stream.fps or 30.0))

        ball_motion = np.clip(col("ball_speed") / 0.6, 0.0, 1.0) * col("ball_present")
        activity = col("player_activity_w")

        # Impulses are one frame wide.  Hold them with exponential decay so a
        # sustained-evidence threshold can actually see them -- without this, a
        # serve is invisible to a rule that asks for four consecutive frames.
        serve = _decay(col("ev_serve"), tau_frames)

        # "Rhythm": the tempo of crossings and contacts.  This is what live play
        # looks like from a distance, and unlike any single event it is robust
        # to the detector missing one.
        rhythm = np.maximum(
            np.clip(col("rate_net_cross") / 0.6, 0.0, 1.0),
            np.clip(col("rate_contact") / 1.2, 0.0, 1.0),
        )

        # Noisy-OR, not a weighted mean.  These signals are alternative
        # evidence for the same proposition, not components of it: a clear serve
        # is enough on its own, and so is a sustained rhythm of net crossings.
        # A weighted mean divided by the total weight makes every signal
        # individually insufficient, which in practice means nothing but a serve
        # can ever open a rally -- exactly the failure this replaced.
        start = _noisy_or([
            (c.w_start_serve, serve),
            (c.w_start_net_cross, rhythm),
            (c.w_start_ball_motion, ball_motion),
            (c.w_start_player_activity, activity),
        ])

        # Occlusion pressure: how far into a ball gap we are, weighted by how
        # quiet the court has gone.  This is the term that distinguishes
        # "somebody is standing in front of the ball" from "the point is over".
        gap_s = col("gap_norm") * GAP_REFERENCE_S
        quiet = np.clip(1.0 - activity / max(1e-6, c.quiet_activity_threshold * 3.0), 0.0, 1.0)
        gap_budget = c.quiet_ball_gap_s + (c.max_ball_gap_s - c.quiet_ball_gap_s) * (1.0 - quiet)
        occlusion = np.clip(gap_s / np.maximum(1e-6, gap_budget), 0.0, 1.5)

        # "Nothing is happening" has two shapes, and only one of them is the
        # ball disappearing.  The other -- and the more common one on real
        # footage -- is the ball still plainly visible, lying on the court where
        # it landed.  Scoring only the first leaves the rally open until the
        # players wander out of frame, which is seconds after the point ended.
        quiet_players = np.clip(
            1.0 - activity / max(1e-6, c.quiet_activity_threshold * 2.0), 0.0, 1.0)
        still_ball = np.clip(1.0 - col("ball_speed") / RESUME_MIN_BALL_SPEED, 0.0, 1.0)
        no_play = np.maximum(1.0 - col("ball_observed"), still_ball * col("ball_present"))
        low_activity = quiet_players * no_play

        end = _noisy_or([
            (c.w_end_out, col("ev_out")),
            (c.w_end_net_contact, col("ev_net_contact")),
            (c.w_end_ground, np.maximum(col("ev_double_bounce"), col("ev_roll"))),
            (c.w_end_next_serve, col("ev_serve")),
            (c.w_end_occlusion, np.clip(occlusion, 0.0, 1.0)),
            (c.w_end_low_activity, low_activity),
        ])

        return Scores(start.astype(np.float32), end.astype(np.float32),
                      occlusion.astype(np.float32), gap_s.astype(np.float32))

    def frame_probability(self, stream: FeatureStream) -> Optional[np.ndarray]:
        """Per-frame rally likelihood, for the overlay and the ensemble."""
        n = len(stream)
        prob = np.zeros(n, dtype=np.float32)
        for seg in self.segment(stream):
            i0, i1 = stream.index_at(seg.start_s), stream.index_at(seg.end_s)
            prob[i0 : max(i0 + 1, i1)] = seg.confidence
        return prob

    # --- state machine -----------------------------------------------------

    def segment(self, stream: FeatureStream) -> List[RallySegment]:
        c = self.cfg
        n = len(stream)
        if n == 0:
            return []

        sc = self.scores(stream)
        t = stream.t
        fps = stream.fps or 30.0
        duration = float(t[-1]) if n else 0.0

        observed = stream.col("ball_observed")
        activity = stream.col("player_activity_w")
        ball_speed = stream.col("ball_speed")

        # Index events by frame for O(1) lookup inside the loop.
        by_frame: dict = {}
        for e in stream.events:
            i = stream.index_at(e.t_s)
            by_frame.setdefault(i, []).append(e)

        segments: List[RallySegment] = []
        state = IDLE
        start_run = 0
        stop_run = 0
        raw_start_i = 0
        start_evidence: List[Evidence] = []
        last_obs_i = -10 ** 9
        pending: Optional[Tuple[Optional[Event], EndReason, float, int]] = None
        pending_deadline = 0
        confirm_frames = max(1, int(round(c.end_confirm_s * fps)))
        # True hysteresis: after a rally closes, the start evidence has to fall
        # away before another rally may open.  Without this the windowed rates
        # and decayed impulses left over from the rally that just ended are
        # still above the start threshold, so the machine re-opens on its own
        # exhaust a frame later -- and post-processing then merges the two back
        # into one long rally, which is exactly the bug this replaced.
        rearmed = True

        def close(end_i: int, reason: EndReason, conf: float, ev: Optional[Event]) -> None:
            seg = self._build_segment(stream, raw_start_i, end_i, start_evidence,
                                      reason, conf, ev, sc)
            self._log(float(t[end_i]), f"CLOSE {reason.value} conf={conf:.2f} "
                                       f"{'kept' if seg else 'DROPPED'}")
            if seg is not None:
                segments.append(seg)

        def arm(ev: Optional[Event], reason: EndReason, conf: float, end_i: int, i: int) -> None:
            """Propose an end.  Committed only if play does not resume."""
            nonlocal pending, pending_deadline, state
            pending = (ev, reason, conf, end_i)
            pending_deadline = i + confirm_frames
            state = ENDING
            self._log(float(t[i]), f"ARM {reason.value} conf={conf:.2f} "
                                   f"(confirm until {float(t[min(pending_deadline, n - 1)]):.2f})")

        for i in range(n):
            if observed[i] > 0.5:
                last_obs_i = i
            events_here = by_frame.get(i, [])

            # --- waiting to see whether the rally really ended ---
            if state == ENDING:
                # "Play resumed" has to mean the ball is actually moving again.
                # A ball trickling to a stop throws off contact-shaped noise, and
                # accepting that as a resume keeps every rally open for seconds
                # past its real end.
                moving = ball_speed[i] >= RESUME_MIN_BALL_SPEED
                resumed = any(
                    e.confidence >= 0.55 and (
                        e.kind == NET_CROSS or (e.kind == PADDLE_CONTACT and moving)
                    )
                    for e in events_here
                )
                if resumed:
                    self._log(float(t[i]), "RESUME (end cancelled)")
                    # False alarm: the ball is still in play.  The boundary was
                    # never moved, so nothing is lost by continuing.
                    pending = None
                    stop_run = 0
                    state = RALLY
                    continue
                if i < pending_deadline:
                    continue
                ev, reason, conf, end_i = pending
                close(end_i, reason, conf, ev)
                pending = None
                stop_run = 0
                if ev is not None and ev.kind == SERVE:
                    # That serve opens the next rally.
                    raw_start_i = stream.index_at(ev.t_s)
                    start_evidence = [Evidence("serve", float(ev.t_s), ev.confidence,
                                               dict(ev.detail))]
                    state = RALLY
                    rearmed = True
                else:
                    state = IDLE
                    start_run = 0
                    rearmed = False
                continue

            if state == IDLE:
                if not rearmed:
                    # Evidence from the rally that just ended has to decay away
                    # first.  Note there is deliberately no "unless it looks
                    # like a serve" exemption: a ball settling on the court
                    # after a point produces serve-shaped motion, and trusting
                    # it re-opens the rally that just closed.  Real gaps between
                    # points are seconds long; the windowed rates clear well
                    # inside that.
                    if sc.start[i] < c.rearm_threshold:
                        rearmed = True
                    else:
                        start_run = 0
                        continue
                if sc.start[i] >= c.start_threshold:
                    start_run += 1
                else:
                    start_run = max(0, start_run - 1)
                if start_run >= c.start_hold_frames:
                    raw_start_i = max(0, i - c.start_hold_frames)
                    start_evidence = self._start_evidence(stream, raw_start_i, i, sc)
                    state = RALLY
                    start_run = 0
                    stop_run = 0
                    self._log(float(t[raw_start_i]), f"START score={sc.start[i]:.2f}")
                continue

            # --- in a rally ---
            established = (t[i] - t[raw_start_i]) >= c.min_established_s

            terminal = None
            for e in events_here:
                if e.kind not in TERMINAL_EVENTS:
                    continue
                if e.kind == SERVE and (t[i] - t[raw_start_i]) < c.min_rally_s:
                    continue
                terminal = e
                break
            if terminal is not None and established:
                reason, weight = TERMINAL_EVENTS[terminal.kind]
                arm(terminal, reason, float(np.clip(terminal.confidence * weight, 0.0, 0.99)), i, i)
                continue

            # Ball-gap tolerance, conditioned on player activity.
            gap_s = (i - last_obs_i) / fps
            budget = (c.quiet_ball_gap_s if activity[i] < c.quiet_activity_threshold
                      else c.max_ball_gap_s)
            if gap_s > budget:
                reason = (EndReason.LOW_ACTIVITY if activity[i] < c.quiet_activity_threshold
                          else EndReason.OCCLUSION_TIMEOUT)
                conf = 0.45 + 0.2 * float(activity[i] < c.quiet_activity_threshold)
                arm(None, reason, conf, max(raw_start_i + 1, last_obs_i), i)
                continue

            # Score decay.
            if sc.end[i] >= c.stop_threshold and sc.start[i] < c.start_threshold:
                stop_run += 1
            else:
                stop_run = max(0, stop_run - 1)
            if stop_run >= c.stop_hold_frames:
                arm(None, EndReason.LOW_ACTIVITY, 0.40, max(raw_start_i + 1, i - c.stop_hold_frames // 2), i)
                continue

            # Hard cap.
            if t[i] - t[raw_start_i] > c.max_rally_s:
                close(i, EndReason.LOW_ACTIVITY, 0.25, None)
                state = IDLE
                start_run = 0
                rearmed = False

        if state == ENDING and pending is not None:
            ev, reason, conf, end_i = pending
            close(end_i, reason, conf, ev)
        elif state == RALLY:
            close(n - 1, EndReason.VIDEO_END, 0.30, None)

        return postprocess(segments, c.min_rally_s, c.max_rally_s, c.merge_gap_s, duration,
                           lead_s=c.lead_s, tail_s=c.tail_s)

    # --- segment construction ---------------------------------------------

    def _start_evidence(self, stream: FeatureStream, i0: int, i1: int, sc: Scores) -> List[Evidence]:
        out: List[Evidence] = []
        lo, hi = float(stream.t[i0]), float(stream.t[min(i1, len(stream) - 1)])
        for e in stream.events_between(lo - 0.5, hi + 0.1, [SERVE, NET_CROSS, PADDLE_CONTACT]):
            out.append(Evidence(e.kind, e.t_s, e.confidence, dict(e.detail)))
        out.append(Evidence("start_score", hi, float(sc.start[min(i1, len(sc.start) - 1)]), {}))
        return out

    def _snap_start(self, stream: FeatureStream, raw_i: int) -> Tuple[int, StartReason, float]:
        """Move the boundary back onto the event that actually began the rally."""
        t = stream.t
        window = 1.6
        lo = float(t[raw_i]) - window
        hi = float(t[raw_i]) + 0.35

        serves = stream.events_between(lo, hi, [SERVE])
        if serves:
            best = max(serves, key=lambda e: e.confidence)
            return stream.index_at(best.t_s), StartReason.SERVE_DETECTED, min(0.95, 0.6 + 0.4 * best.confidence)

        contacts = stream.events_between(lo, hi, [PADDLE_CONTACT])
        if contacts:
            first = min(contacts, key=lambda e: e.t_s)
            return stream.index_at(first.t_s), StartReason.BALL_MOTION_ONSET, 0.65

        crosses = stream.events_between(lo, hi, [NET_CROSS])
        if crosses:
            first = min(crosses, key=lambda e: e.t_s)
            return stream.index_at(first.t_s), StartReason.NET_CROSSING, 0.6

        # Nothing discrete: walk back to where the ball first became visible.
        observed = stream.col("ball_observed")
        i = raw_i
        limit = max(0, raw_i - int(window * (stream.fps or 30.0)))
        while i > limit and observed[i] > 0.5:
            i -= 1
        if i < raw_i:
            return i, StartReason.BALL_MOTION_ONSET, 0.5
        return raw_i, StartReason.PLAYER_ACTIVITY, 0.4

    def _snap_end(self, stream: FeatureStream, start_i: int, end_i: int) -> float:
        """Last moment that still looked like live play, within the snap window."""
        c = self.cfg
        fps = stream.fps or 30.0
        limit = max(start_i + 1, end_i - int(c.end_snap_window_s * fps))
        speed = stream.col("ball_speed")

        best = end_i
        for i in range(end_i, limit - 1, -1):
            if speed[i] >= RESUME_MIN_BALL_SPEED:
                best = i
                break
        else:
            best = limit

        # A crossing or a contact is stronger evidence of play than raw speed,
        # so prefer the later of the two.
        events = stream.events_between(float(stream.t[limit]), float(stream.t[end_i]),
                                       [NET_CROSS, PADDLE_CONTACT, BOUNCE])
        if events:
            best = max(best, stream.index_at(max(e.t_s for e in events)))
        return float(stream.t[min(best, end_i)])

    def _build_segment(self, stream: FeatureStream, raw_start_i: int, end_i: int,
                       start_evidence: List[Evidence], reason: EndReason,
                       end_conf: float, end_event: Optional[Event],
                       sc: Scores) -> Optional[RallySegment]:
        c = self.cfg
        n = len(stream)
        end_i = int(np.clip(end_i, 0, n - 1))
        raw_start_i = int(np.clip(raw_start_i, 0, n - 1))
        if end_i <= raw_start_i:
            return None

        snap_i, start_reason, start_conf = self._snap_start(stream, raw_start_i)
        snap_i = min(snap_i, end_i - 1)

        start_s = float(stream.t[snap_i])
        if end_event is not None:
            end_s = float(end_event.t_s)
        else:
            # No terminating event: the machine ran out of evidence rather than
            # seeing the point end.  The rally still ended when the ball stopped
            # being played, not when the score finally sagged, so walk the
            # boundary back to the last frame that actually looked like play.
            end_s = self._snap_end(stream, snap_i, end_i)
        if end_s <= start_s:
            return None

        i0, i1 = stream.index_at(start_s), stream.index_at(end_s)
        i1 = max(i0 + 1, i1)
        window = slice(i0, i1)

        observed = stream.col("ball_observed")[window]
        activity = stream.col("player_activity_w")[window]
        coverage = float(observed.mean()) if observed.size else 0.0
        mean_activity = float(activity.mean()) if activity.size else 0.0

        evs = stream.events_between(start_s, end_s)
        shots = sum(1 for e in evs if e.kind == PADDLE_CONTACT)
        crossings = sum(1 for e in evs if e.kind == NET_CROSS)
        bounces = sum(1 for e in evs if e.kind == BOUNCE)

        evidence = list(start_evidence)
        if end_event is not None:
            evidence.append(Evidence(end_event.kind, end_event.t_s, end_event.confidence,
                                     dict(end_event.detail)))
        else:
            evidence.append(Evidence(reason.value, end_s, end_conf, {}))

        seg = RallySegment(
            idx=0, start_s=max(0.0, start_s), end_s=end_s,
            clip_start_s=max(0.0, start_s - c.lead_s), clip_end_s=end_s + c.tail_s,
            start_reason=start_reason, end_reason=reason,
            start_confidence=float(np.clip(start_conf, 0.0, 1.0)),
            end_confidence=float(np.clip(end_conf, 0.0, 1.0)),
            shots=shots, net_crossings=crossings, bounces=bounces,
            ball_coverage=coverage, mean_player_activity=mean_activity,
            max_ball_speed_mps=_max_speed_mps(stream, i0, i1),
            evidence=evidence,
        )
        seg.confidence = self._segment_confidence(seg)
        return seg

    def _segment_confidence(self, seg: RallySegment) -> float:
        """Blend boundary confidence with how much the rally actually looks like one.

        A rally the tracker barely saw, or one with no net crossings, is a
        candidate for review even when both boundaries looked clean -- so the
        content terms can only pull the number down, never inflate it.
        """
        boundary = 0.5 * seg.start_confidence + 0.5 * seg.end_confidence
        coverage_term = float(np.clip(0.55 + 0.45 * seg.ball_coverage, 0.0, 1.0))
        # Plausible rallies are 2-25 s; outside that, discount.
        d = seg.duration_s
        if d < 2.0:
            duration_term = 0.55 + 0.45 * (d / 2.0)
        elif d <= 25.0:
            duration_term = 1.0
        else:
            duration_term = float(np.clip(1.0 - (d - 25.0) / 40.0, 0.4, 1.0))
        content_term = 1.0 if seg.net_crossings >= 1 or seg.shots >= 2 else 0.75
        return float(np.clip(boundary * coverage_term * duration_term * content_term, 0.0, 0.99))


def _max_speed_mps(stream: FeatureStream, i0: int, i1: int) -> Optional[float]:
    """Peak ball speed in m/s, from court coordinates where the homography holds."""
    from ..detect.court import COURT_L, COURT_W

    valid = stream.col("court_valid")[i0:i1]
    if valid.size < 3 or valid.mean() < 0.2:
        return None
    x = stream.col("ball_court_x")[i0:i1] * COURT_W
    y = stream.col("ball_court_y")[i0:i1] * COURT_L
    t = stream.t[i0:i1]
    speeds = []
    for k in range(1, len(t)):
        if valid[k] < 0.5 or valid[k - 1] < 0.5:
            continue
        dt = t[k] - t[k - 1]
        if dt <= 0:
            continue
        d_ft = math.hypot(x[k] - x[k - 1], y[k] - y[k - 1])
        speeds.append((d_ft * 0.3048) / dt)
    if not speeds:
        return None
    # 95th percentile, not the max: the max is whatever the worst tracking
    # glitch in the rally was.
    return float(np.percentile(speeds, 95))
