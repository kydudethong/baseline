"""Discrete events derived from the ball trajectory, the court and the players.

Everything here answers a pickleball question, not a computer-vision question:

* **bounce** -- the ball touched the ground.  Detected as a sign flip in vertical
  image velocity.  At that instant the ball is genuinely on the court plane, so
  the homography maps it to a real court coordinate; that is what makes
  out-of-bounds a measurement rather than an estimate.
* **paddle_contact** -- someone hit it.  A velocity change that a bounce cannot
  explain: a horizontal reversal, or a speed increase, away from the ground.
* **net_cross** -- the ball changed sides.
* **net_contact** -- the ball reached the net band, lost most of its speed and
  dropped, without crossing.  Rally over.
* **double_bounce** -- two bounces with no contact between them.  In pickleball
  that is unambiguous: the point is over.  This is the single most reliable
  rally-end signal there is, and it is the reason the pipeline works this way
  round rather than trying to spot "players walking back to the baseline".
* **serve** -- a quiet stretch, a player behind a baseline, the ball rising from
  low and crossing the net.  Doubles as a rally start *and* as an end signal for
  the rally before it, which is what catches endings the ball never showed you.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Dict, List, Optional, Sequence, Tuple

import numpy as np

from .config import EventConfig
from .detect.court import COURT_L, COURT_W, NET_Y, CourtModel
from .track.ball_track import BallState
from .track.bytetrack import Track

BOUNCE = "bounce"
PADDLE_CONTACT = "paddle_contact"
NET_CROSS = "net_cross"
NET_CONTACT = "net_contact"
OUT_OF_BOUNDS = "out_of_bounds"
DOUBLE_BOUNCE = "double_bounce"
BALL_ROLL = "ball_roll"
SERVE = "serve"

ALL_EVENT_KINDS = [
    BOUNCE, PADDLE_CONTACT, NET_CROSS, NET_CONTACT,
    OUT_OF_BOUNDS, DOUBLE_BOUNCE, BALL_ROLL, SERVE,
]


@dataclass
class Event:
    kind: str
    t_s: float
    frame_index: int
    confidence: float = 1.0
    detail: Dict[str, object] = field(default_factory=dict)


@dataclass
class _Sample:
    t_s: float
    frame_index: int
    xy: np.ndarray
    observed: bool
    court_xy: Optional[np.ndarray]
    activity: float
    track_id: int


class EventDetector:
    def __init__(self, cfg: EventConfig, court, fps: float, image_size: Tuple[int, int],
                 out_margin_ft: float = 0.6):
        self.cfg = cfg
        self.court = court
        self.out_margin_ft = out_margin_ft
        self.fps = max(1e-6, fps)
        self.image_size = image_size
        self.has_court = isinstance(court, CourtModel)

        self.samples: Deque[_Sample] = deque(maxlen=180)
        self.activity_hist: Deque[Tuple[float, float]] = deque(maxlen=600)

        self._net_side: Optional[int] = None
        self._net_cross_cooldown = 0
        self._last_bounce: Optional[Event] = None
        self._last_contact_t: float = -1e9
        self._net_band_entry: Optional[Tuple[float, float, np.ndarray]] = None  # (t, speed, xy)
        self._last_serve_t: float = -1e9
        self._rolled_for_bounce_t: float = -1e9
        self._last_impulse_t: float = -1e9
        self._last_play_event_t: float = -1e9
        self._last_net_contact_t: float = -1e9

    # --- main ---------------------------------------------------------------

    def update(self, ball: BallState, players: Sequence[Track], t_s: float,
               frame_index: int) -> List[Event]:
        activity = player_activity(players, self.image_size, self.fps)
        self.activity_hist.append((t_s, activity))

        events: List[Event] = []
        if self._net_cross_cooldown > 0:
            self._net_cross_cooldown -= 1

        if not (ball.present and ball.xy is not None):
            self._net_band_entry = None
            serve = self._detect_serve(None, players, t_s, frame_index, activity)
            if serve:
                events.append(serve)
            return events

        court_xy = None
        if self.has_court:
            mapped = self.court.to_court(ball.xy.reshape(1, 2))[0]
            if np.all(np.isfinite(mapped)):
                court_xy = mapped

        sample = _Sample(t_s, frame_index, ball.xy.copy(), ball.observed, court_xy,
                         activity, ball.track_id)

        track_changed = bool(self.samples) and self.samples[-1].track_id != ball.track_id
        self.samples.append(sample)
        if track_changed:
            # A hypothesis takeover produces a position jump that would read as a
            # violent paddle contact.  Skip event extraction for one frame.
            return events

        # Physical events are only ever derived from *observed* positions.  A
        # coasting Kalman prediction is a guess about where the ball is, and a
        # bounce or a contact inferred from a guess is a fabrication.
        if not sample.observed:
            serve = self._detect_serve(None, players, t_s, frame_index, activity)
            if serve:
                events.append(serve)
            return events

        cross = self._detect_net_cross(sample)
        if cross:
            events.append(cross)
            self._last_play_event_t = cross.t_s

        impulse = self._detect_impulse(players)
        if impulse is not None and impulse.kind == BOUNCE:
            events.append(impulse)
            out = self._check_out_of_bounds(impulse)
            if out:
                events.append(out)
            double = self._check_double_bounce(impulse)
            if double:
                events.append(double)
            self._last_bounce = impulse
        elif impulse is not None:
            events.append(impulse)
            self._last_contact_t = impulse.t_s
            self._last_play_event_t = impulse.t_s

        roll = self._detect_roll()
        if roll:
            events.append(roll)

        net_hit = self._detect_net_contact(sample, bool(cross))
        if net_hit:
            events.append(net_hit)

        serve = self._detect_serve(sample, players, t_s, frame_index, activity)
        if serve:
            events.append(serve)
            self._last_serve_t = t_s

        return events

    # --- individual detectors ----------------------------------------------

    def _velocity(self, k: int = 3) -> Optional[np.ndarray]:
        """Least-squares velocity over the last ``k`` samples, in px/s."""
        if len(self.samples) < k:
            return None
        pts = list(self.samples)[-k:]
        t = np.array([s.t_s for s in pts])
        if t[-1] - t[0] < 1e-6:
            return None
        xy = np.array([s.xy for s in pts])
        t0 = t - t.mean()
        denom = float((t0 ** 2).sum()) or 1e-6
        vx = float((t0 * (xy[:, 0] - xy[:, 0].mean())).sum() / denom)
        vy = float((t0 * (xy[:, 1] - xy[:, 1].mean())).sum() / denom)
        return np.array([vx, vy])

    def _detect_net_cross(self, sample: _Sample) -> Optional[Event]:
        if sample.court_xy is not None:
            side = -1 if sample.court_xy[1] < NET_Y else 1
            margin_ok = abs(sample.court_xy[1] - NET_Y) > 0.5   # ft
        else:
            p0, p1 = self.court.net_line_px
            if abs(p1[0] - p0[0]) < 1e-6:
                y_net = (p0[1] + p1[1]) / 2.0
            else:
                t = np.clip((sample.xy[0] - p0[0]) / (p1[0] - p0[0]), 0.0, 1.0)
                y_net = float(p0[1] + t * (p1[1] - p0[1]))
            side = -1 if sample.xy[1] > y_net else 1     # image y grows downward
            margin_ok = abs(sample.xy[1] - y_net) > self.cfg.net_cross_min_dx_px

        if not margin_ok:
            return None
        prev = self._net_side
        self._net_side = side
        if prev is None or prev == side or self._net_cross_cooldown > 0:
            return None
        self._net_cross_cooldown = self.cfg.net_cross_cooldown_frames
        return Event(NET_CROSS, sample.t_s, sample.frame_index, 0.9,
                     {"to_side": int(side)})

    def _detect_impulse(self, players: Sequence[Track]) -> Optional[Event]:
        """Find where the trajectory stops being one parabola, and say why.

        A ball in free flight traces a parabola in image space -- gravity
        included.  So the test for "something hit it" is not that the velocity
        changed (gravity changes the velocity every frame, and near the camera
        it changes it a *lot*), but that a parabola fitted to the frames before
        the junction and one fitted to the frames after disagree about the
        velocity at the junction.  Fitting quadratics rather than lines is what
        subtracts gravity out, and without it every steep descent registers as a
        paddle strike.

        The same measurement then splits two ways, physically:

        * a **bounce** kicks the ball upward and leaves the horizontal direction
          alone, because the court cannot push sideways;
        * a **paddle contact** reverses the direction of travel or adds energy.

        Note this is deliberately not phrased as "a local maximum of image y":
        for a ball travelling toward the camera the ground point sweeps down the
        frame fast enough to mask the bounce entirely.
        """
        w = max(2, self.cfg.bounce_window)
        need = 2 * w + 1
        if len(self.samples) < need:
            return None
        pts = list(self.samples)[-need:]
        if sum(1 for s in pts if s.observed) < 0.6 * len(pts):
            return None

        # Let the junction sit anywhere near the middle: the Kalman filter lags
        # the measurement by a frame or two, and pinning it to a fixed index
        # throws away real events.
        best = None
        for k in range(w - 1, w + 2):
            if k < 2 or k > len(pts) - 3:
                continue
            vb = _fit_velocity_quadratic(pts[: k + 1], pts[k].t_s)
            va = _fit_velocity_quadratic(pts[k:], pts[k].t_s)
            if vb is None or va is None:
                continue
            dv = float(np.linalg.norm(va - vb))
            if best is None or dv > best[0]:
                best = (dv, k, vb, va)
        if best is None:
            return None

        dv, k, v_before, v_after = best
        mid = pts[k]
        if not mid.observed:
            return None
        s_before = float(np.linalg.norm(v_before))
        s_after = float(np.linalg.norm(v_after))
        if max(s_before, s_after) < self.cfg.impulse_min_speed_px_s:
            return None
        if dv < self.cfg.impulse_min_px_s:
            return None
        if dv < self.cfg.impulse_rel * max(s_before, s_after):
            return None
        if mid.t_s - self._last_impulse_t < self.cfg.impulse_cooldown_s:
            return None

        # --- classify ---
        falling = v_before[1] > self.cfg.bounce_min_speed_px_s
        kicked_up = (v_before[1] - v_after[1]) > self.cfg.impulse_min_px_s * 0.5
        vx_flip = (v_before[0] * v_after[0] < 0
                   and min(abs(v_before[0]), abs(v_after[0])) > 40.0)
        sped_up = s_after > 1.35 * max(60.0, s_before)
        near_player = self._near_player(mid.xy, players)

        # Player proximity is a hint, not a veto.  Dinks land at the kitchen
        # line a foot in front of somebody's shoes; vetoing bounces near players
        # would delete exactly the shots that define the game.
        is_bounce = falling and kicked_up and not vx_flip and not sped_up
        self._last_impulse_t = mid.t_s

        if is_bounce:
            strength = min(1.0, dv / (5.0 * self.cfg.impulse_min_px_s))
            if near_player:
                strength *= 0.7
            detail: Dict[str, object] = {"xy": mid.xy.tolist(), "dv": round(dv, 1)}
            if mid.court_xy is not None:
                detail["court_xy"] = [float(mid.court_xy[0]), float(mid.court_xy[1])]
            return Event(BOUNCE, mid.t_s, mid.frame_index, 0.55 + 0.4 * strength, detail)

        if not (vx_flip or sped_up or (near_player and dv > 2.0 * self.cfg.impulse_min_px_s)):
            return None
        conf = 0.55 + 0.15 * float(vx_flip) + 0.15 * float(sped_up) + 0.1 * float(near_player)
        return Event(PADDLE_CONTACT, mid.t_s, mid.frame_index, min(0.95, conf),
                     {"speed_before": round(s_before, 1), "speed_after": round(s_after, 1),
                      "near_player": bool(near_player)})

    def _near_player(self, xy: np.ndarray, players: Sequence[Track]) -> bool:
        if not players:
            return False
        m = self.cfg.contact_player_margin_px
        for p in players:
            x1, y1, x2, y2 = p.xyxy
            if (x1 - m) <= xy[0] <= (x2 + m) and (y1 - m) <= xy[1] <= (y2 + m):
                return True
        return False

    def _check_out_of_bounds(self, bounce: Event) -> Optional[Event]:
        court_xy = bounce.detail.get("court_xy")
        if court_xy is None or not self.has_court:
            return None
        x, y = float(court_xy[0]), float(court_xy[1])
        margin = self.out_margin_ft
        outside_by = max(
            -x - 0.0, x - COURT_W,
            -y - 0.0, y - COURT_L,
        )
        if outside_by <= margin:
            return None
        # Reject absurd mappings: a bounce 40 ft off court is a bad homography or
        # a ball from the next court, not a line call.
        if outside_by > 25.0:
            return None
        conf = float(np.clip(0.5 + outside_by / 4.0, 0.5, 0.98))
        if conf < self.cfg.out_min_confidence:
            return None
        return Event(OUT_OF_BOUNDS, bounce.t_s, bounce.frame_index, conf,
                     {"court_xy": [x, y], "outside_by_ft": round(outside_by, 2)})

    def _check_double_bounce(self, bounce: Event) -> Optional[Event]:
        prev = self._last_bounce
        if prev is None:
            return None
        gap = bounce.t_s - prev.t_s
        if gap <= 0 or gap > 2.5:
            return None
        if self._last_contact_t > prev.t_s:
            return None      # someone hit it in between: legal play
        conf = float(np.clip(0.95 - 0.15 * gap, 0.5, 0.95))
        return Event(DOUBLE_BOUNCE, bounce.t_s, bounce.frame_index, conf,
                     {"gap_s": round(gap, 3)})

    def _detect_roll(self) -> Optional[Event]:
        """Ball on the ground and barely moving: the point is over."""
        if self._last_bounce is None or len(self.samples) < 8:
            return None
        pts = list(self.samples)[-8:]
        if pts[0].t_s - self._last_bounce.t_s < 0.0 or pts[-1].t_s - self._last_bounce.t_s > 3.0:
            return None
        v = _fit_velocity(pts)
        if v is None:
            return None
        speed = float(np.linalg.norm(v))
        y_span = max(s.xy[1] for s in pts) - min(s.xy[1] for s in pts)
        if speed > 220.0 or y_span > 14.0:
            return None
        if self._last_contact_t > self._last_bounce.t_s:
            return None
        if self._rolled_for_bounce_t == self._last_bounce.t_s:
            return None      # one roll call per bounce, not one per frame
        self._rolled_for_bounce_t = self._last_bounce.t_s
        return Event(BALL_ROLL, pts[-1].t_s, pts[-1].frame_index, 0.7,
                     {"speed_px_s": round(speed, 1)})

    def _detect_net_contact(self, sample: _Sample, crossed: bool) -> Optional[Event]:
        top, base = self.court.net_band_px(float(sample.xy[0]))
        band = self.cfg.net_contact_band_px
        in_band = (top - band) <= sample.xy[1] <= (base + band * 0.5)
        v = self._velocity(3)
        speed = float(np.linalg.norm(v)) if v is not None else 0.0

        if sample.t_s - self._last_net_contact_t < 1.0:
            return None
        if in_band and self._net_band_entry is None and speed > 150.0:
            self._net_band_entry = (sample.t_s, speed, self._net_side)
            return None
        if self._net_band_entry is None:
            return None

        t_entry, speed_entry, side_entry = self._net_band_entry
        elapsed = sample.t_s - t_entry
        # A ball that changed sides went *over* the net, whatever its speed did.
        if crossed or side_entry != self._net_side or elapsed > self.cfg.net_contact_window / self.fps:
            self._net_band_entry = None
            return None
        if not in_band:
            self._net_band_entry = None
            return None
        if speed < self.cfg.net_contact_speed_drop * speed_entry and v is not None and v[1] > 0:
            self._net_band_entry = None
            self._last_net_contact_t = sample.t_s
            conf = float(np.clip(0.55 + 0.4 * (1.0 - speed / max(1.0, speed_entry)), 0.55, 0.95))
            return Event(NET_CONTACT, sample.t_s, sample.frame_index, conf,
                         {"speed_entry": round(speed_entry, 1), "speed_now": round(speed, 1)})
        return None

    def _detect_serve(self, sample: Optional[_Sample], players: Sequence[Track],
                      t_s: float, frame_index: int, activity: float) -> Optional[Event]:
        """Serve = quiet, then a player deep, then the ball rising and crossing."""
        if t_s - self._last_serve_t < 1.5:
            return None
        # A serve is preceded by *nothing happening*.  Quiet players are not
        # enough on their own -- they go still during a slow dink exchange too.
        # Requiring no crossing and no contact for the whole window is what
        # separates a serve from a lull, and it is the difference between the
        # next-serve signal ending rallies and splitting them.
        if t_s - self._last_play_event_t < self.cfg.serve_quiet_window_s:
            return None
        prior = self._activity_before(t_s, self.cfg.serve_quiet_window_s)
        if prior is None or prior > self.cfg.serve_max_prior_activity:
            return None
        if sample is None:
            return None

        v = self._velocity(4)
        if v is None or -v[1] < self.cfg.serve_min_rise_px_s:
            return None      # image y decreasing == ball rising

        deep_player = self._has_deep_player(players)
        score = 0.45 + 0.25 * float(deep_player)
        if sample.court_xy is not None:
            depth = min(sample.court_xy[1], COURT_L - sample.court_xy[1]) / COURT_L
            if depth < self.cfg.serve_baseline_frac:
                score += 0.25
        else:
            h = self.image_size[1]
            if sample.xy[1] > h * 0.72 or sample.xy[1] < h * 0.28:
                score += 0.15
        score += 0.15 * float(max(0.0, self.cfg.serve_max_prior_activity - prior)
                              / max(1e-6, self.cfg.serve_max_prior_activity))
        if score < 0.6:
            return None
        return Event(SERVE, t_s, frame_index, min(0.95, score),
                     {"prior_activity": round(prior, 4), "deep_player": bool(deep_player)})

    # --- helpers ------------------------------------------------------------

    def _activity_before(self, t_s: float, window_s: float) -> Optional[float]:
        lo, hi = t_s - window_s, t_s - 0.05
        vals = [a for (t, a) in self.activity_hist if lo <= t <= hi]
        if len(vals) < 3:
            return None
        return float(np.mean(vals))

    def _has_deep_player(self, players: Sequence[Track]) -> bool:
        if not players:
            return False
        if self.has_court:
            for p in players:
                pt = self.court.to_court(p.feet.reshape(1, 2))[0]
                if not np.all(np.isfinite(pt)):
                    continue
                depth = min(pt[1], COURT_L - pt[1])
                if -3.0 <= depth <= self.cfg.serve_baseline_frac * COURT_L:
                    return True
            return False
        h = self.image_size[1]
        return any(p.feet[1] > 0.85 * h or p.feet[1] < 0.30 * h for p in players)


def _fit_velocity_quadratic(pts: Sequence[_Sample], at_t: float) -> Optional[np.ndarray]:
    """Instantaneous velocity at ``at_t`` from a quadratic fit -- gravity included.

    Three points is the minimum for a parabola; with fewer, fall back to the
    straight-line fit rather than returning nothing.
    """
    if len(pts) < 3:
        return _fit_velocity(pts)
    t = np.array([s.t_s for s in pts])
    if t[-1] - t[0] < 1e-6:
        return None
    t0 = t - at_t
    xy = np.array([s.xy for s in pts], dtype=np.float64)
    try:
        cx = np.polyfit(t0, xy[:, 0], 2)
        cy = np.polyfit(t0, xy[:, 1], 2)
    except (np.linalg.LinAlgError, ValueError):
        return _fit_velocity(pts)
    # d/dt (a t^2 + b t + c) at t = 0 is b.
    return np.array([cx[1], cy[1]])


def _fit_velocity(pts: Sequence[_Sample]) -> Optional[np.ndarray]:
    if len(pts) < 2:
        return None
    t = np.array([s.t_s for s in pts])
    if t[-1] - t[0] < 1e-6:
        return None
    xy = np.array([s.xy for s in pts])
    t0 = t - t.mean()
    denom = float((t0 ** 2).sum()) or 1e-6
    vx = float((t0 * (xy[:, 0] - xy[:, 0].mean())).sum() / denom)
    vy = float((t0 * (xy[:, 1] - xy[:, 1].mean())).sum() / denom)
    return np.array([vx, vy])


#: Mean player speed, in body-heights per second, that counts as "flat out".
#: Everything reports activity on a 0..1 scale against this, in one place, so a
#: threshold means the same thing in the event detector, the features and the
#: state machine.
ACTIVITY_FULL_SCALE = 3.0


def player_activity(players: Sequence[Track], image_size: Tuple[int, int], fps: float) -> float:
    """Mean player speed on a 0..1 scale, resolution- and fps-independent.

    Measured in body-heights per second, which is roughly scale invariant: a
    player at the far baseline is half the pixel height of one at the near
    kitchen line, and without that normalisation the far pair would look
    permanently idle.
    """
    if not players:
        return 0.0
    speeds = []
    for p in players:
        h = max(8.0, float(p.x[3]))
        speeds.append((p.speed_px * fps) / h)
    return float(np.clip(np.mean(speeds) / ACTIVITY_FULL_SCALE, 0.0, 1.0))
