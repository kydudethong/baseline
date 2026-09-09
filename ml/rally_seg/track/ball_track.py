"""Ball tracking.

Constant-acceleration Kalman filter in image space with gravity folded into the
vertical acceleration, plus a small bank of competing hypotheses.

The hypotheses matter more than the filter.  A single-track tracker locks onto
the first plausible blob, and on real footage the first plausible blob is
routinely a player's white shoe, a ball on the next court, or a gull.  Keeping
three candidates and promoting whichever accumulates the most detection support
recovers from that within a few frames instead of losing the rest of the rally.

Coasting is the second half of it.  When the ball passes in front of a dark
shirt the detector drops it for a handful of frames; the filter keeps predicting
and the track survives, which is what lets the state machine tell "occluded"
apart from "gone".
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, List, Optional, Sequence, Tuple

import numpy as np

from ..config import BallTrackConfig
from ..detect.ball import Detection


@dataclass
class BallObservation:
    t_s: float
    frame_index: int
    xy: np.ndarray
    observed: bool
    conf: float


class BallTrack:
    _next_id = 1

    def __init__(self, det: Detection, t_s: float, frame_index: int, cfg: BallTrackConfig, dt: float):
        self.id = BallTrack._next_id
        BallTrack._next_id += 1
        self.cfg = cfg
        self.dt = dt
        # [x, y, vx, vy]
        self.x = np.array([det.x, det.y, 0.0, 0.0], dtype=np.float64)
        self.P = np.diag([16.0, 16.0, 1e4, 1e4])
        self.hits = 1
        self.misses = 0
        self.age = 0
        self.score = det.conf
        self.last_conf = det.conf
        self.history: List[BallObservation] = [
            BallObservation(t_s, frame_index, self.x[:2].copy(), True, det.conf)
        ]

    # --- properties -------------------------------------------------------

    @property
    def pos(self) -> np.ndarray:
        return self.x[:2].copy()

    @property
    def vel(self) -> np.ndarray:
        return self.x[2:4].copy()

    @property
    def speed_px_s(self) -> float:
        return float(np.hypot(self.x[2], self.x[3]) / max(1e-6, self.dt))

    @property
    def confirmed(self) -> bool:
        return self.hits >= self.cfg.min_hits

    @property
    def alive(self) -> bool:
        return self.misses <= self.cfg.max_coast_frames

    # --- filter -----------------------------------------------------------

    def predict(self) -> None:
        g = self.cfg.gravity_px_s2 * self.dt * self.dt
        F = np.array([
            [1, 0, 1, 0],
            [0, 1, 0, 1],
            [0, 0, 1, 0],
            [0, 0, 0, 1],
        ], dtype=np.float64)
        self.x = F @ self.x
        self.x[1] += 0.5 * g      # gravity acts on position...
        self.x[3] += g            # ...and on vertical velocity
        q = self.cfg.process_noise
        Q = np.diag([q * 0.5, q * 0.5, q, q])
        self.P = F @ self.P @ F.T + Q
        self.age += 1

    def gate(self, det: Detection) -> Tuple[float, float]:
        """Statistical and physical distance of a detection from the prediction.

        Returns ``(mahalanobis_squared, pixels)``.  The caller accepts on either
        -- see ``physical_gate_frac``.
        """
        H = np.array([[1.0, 0, 0, 0], [0, 1.0, 0, 0]])
        r = self.cfg.measurement_noise
        S = H @ self.P @ H.T + np.diag([r, r])
        innov = np.array([det.x, det.y]) - H @ self.x
        pixels = float(np.linalg.norm(innov))
        try:
            return float(innov @ np.linalg.inv(S) @ innov), pixels
        except np.linalg.LinAlgError:
            return float("inf"), pixels

    def update(self, det: Optional[Detection], t_s: float, frame_index: int) -> None:
        if det is None:
            self.misses += 1
            self.score *= self.cfg.hypothesis_decay
            self.history.append(BallObservation(t_s, frame_index, self.x[:2].copy(), False, 0.0))
        else:
            H = np.array([[1.0, 0, 0, 0], [0, 1.0, 0, 0]])
            r = self.cfg.measurement_noise
            R = np.diag([r, r])
            z = np.array([det.x, det.y], dtype=np.float64)
            y = z - H @ self.x
            # A large innovation means the ball did something the model cannot
            # express -- it bounced or was struck.  Inflate the velocity
            # covariance so the filter forgets the old velocity quickly instead
            # of averaging across the discontinuity for the next ten frames.
            if float(np.linalg.norm(y)) > 0.35 * self.cfg.max_speed_px_s * self.dt:
                self.P[2:, 2:] *= 16.0
            S = H @ self.P @ H.T + R
            K = self.P @ H.T @ np.linalg.inv(S)
            self.x = self.x + K @ y
            self.P = (np.eye(4) - K @ H) @ self.P
            self.hits += 1
            self.misses = 0
            self.last_conf = det.conf
            self.score = self.score * self.cfg.hypothesis_decay + det.conf
            self.history.append(BallObservation(t_s, frame_index, self.x[:2].copy(), True, det.conf))

        # Runaway velocities mean the filter has locked onto noise.
        vmax = self.cfg.max_speed_px_s * self.dt
        speed = float(np.hypot(self.x[2], self.x[3]))
        if speed > vmax:
            self.x[2:4] *= vmax / speed

        if len(self.history) > 600:
            self.history.pop(0)

    def recent(self, n: int) -> List[BallObservation]:
        return self.history[-n:]


@dataclass
class BallState:
    """What the feature builder sees each frame."""

    t_s: float
    frame_index: int
    present: bool                    # a confirmed track exists (observed or coasting)
    observed: bool                   # a detection was actually associated this frame
    xy: Optional[np.ndarray] = None
    vel_px_s: Optional[np.ndarray] = None
    speed_px_s: float = 0.0
    conf: float = 0.0
    track_id: int = -1
    track_age: int = 0
    misses: int = 0
    n_candidates: int = 0


class BallTracker:
    def __init__(self, cfg: BallTrackConfig, fps: float,
                 scale_at: Optional[Callable[[float], float]] = None):
        self.cfg = cfg
        self.dt = 1.0 / max(1e-6, fps)
        self.tracks: List[BallTrack] = []
        self.primary_id: int = -1
        # Perspective means one pixel is worth wildly different distances at
        # different depths -- on a camera behind the baseline, ~85 px/ft at the
        # near line and ~8 px/ft at the far one.  A single pixel speed limit is
        # therefore either far too loose at the far end (the ball appears to
        # teleport between fence posts) or far too tight at the near end.  So
        # the gate is stated in feet per second and converted using the scale
        # *at the ball's own image position*.
        self.scale_at = scale_at

    def _max_jump(self, y_image: float, misses: int = 0) -> float:
        """Furthest the ball could physically have moved since it was last seen.

        Scales with elapsed frames, because that is the actual constraint: over
        five missed frames a ball can be five frames' travel away.  The earlier
        version tightened the window while coasting, which stopped the tracker
        jumping to the fence but also stopped it picking the ball back up after
        an occlusion -- trading one failure for a worse one.
        """
        px_s = self.cfg.max_speed_px_s
        if self.scale_at is not None:
            scale = self.scale_at(y_image)
            if np.isfinite(scale) and scale > 0:
                px_s = min(px_s, self.cfg.max_speed_ft_s * scale)
        growth = 1 + min(int(misses), int(self.cfg.coast_growth_max))
        return self.cfg.physical_gate_frac * px_s * self.dt * growth

    def update(self, detections: Sequence[Detection], t_s: float, frame_index: int) -> BallState:
        for track in self.tracks:
            track.predict()

        dets = list(detections)
        # Greedy association: best (gate, confidence) pair first.  With at most a
        # handful of candidates this is optimal in practice and far simpler than
        # a global assignment.
        pairs: List[Tuple[float, int, int]] = []
        for ti, track in enumerate(self.tracks):
            max_jump = self._max_jump(float(track.x[1]), track.misses)
            # A coasting track's covariance grows fast, so its *statistical*
            # gate opens widest exactly when the track is least reliable --
            # which is how a ball hidden behind a player gets "found" on the far
            # fence. The physical bound is always applied; the statistical one
            # is only allowed to accept, never to override it.
            for di, det in enumerate(dets):
                d2, pixels = track.gate(det)
                if pixels > max_jump:
                    continue
                if d2 <= self.cfg.gate_mahalanobis or pixels <= max_jump:
                    # Rank by the statistical distance where it is meaningful and
                    # by pixels where it is not, so the nearest plausible
                    # detection still wins.
                    cost = min(d2, pixels / max(1e-6, max_jump) * self.cfg.gate_mahalanobis)
                    pairs.append((cost - 2.0 * det.conf, ti, di))
        pairs.sort()

        used_t, used_d = set(), set()
        assigned = {}
        for _cost, ti, di in pairs:
            if ti in used_t or di in used_d:
                continue
            assigned[ti] = di
            used_t.add(ti)
            used_d.add(di)

        for ti, track in enumerate(self.tracks):
            track.update(dets[assigned[ti]] if ti in assigned else None, t_s, frame_index)

        for di, det in enumerate(dets):
            if di in used_d:
                continue
            if len(self.tracks) < self.cfg.max_hypotheses:
                self.tracks.append(BallTrack(det, t_s, frame_index, self.cfg, self.dt))
            else:
                # Replace the weakest hypothesis rather than ignore a detection:
                # the ball reappearing far from the prediction (a hard smash, a
                # cut in the footage) has to be able to take over.
                weakest = min(range(len(self.tracks)), key=lambda i: self.tracks[i].score)
                if self.tracks[weakest].score < det.conf and not self.tracks[weakest].confirmed:
                    self.tracks[weakest] = BallTrack(det, t_s, frame_index, self.cfg, self.dt)

        self.tracks = [t for t in self.tracks if t.alive]

        primary = self._primary()
        if primary is None:
            self.primary_id = -1
            return BallState(t_s=t_s, frame_index=frame_index, present=False, observed=False,
                             n_candidates=len(self.tracks))

        self.primary_id = primary.id
        last = primary.history[-1]

        # A coasting track is the filter's guess, not an observation.  Unless
        # explicitly asked for, report it as "no ball this frame" rather than
        # handing a predicted position downstream where nothing can tell it
        # apart from a real one.  The track itself stays alive internally, so
        # the ball is still reacquired the moment it reappears.
        if not last.observed and not self.cfg.report_predicted_positions:
            return BallState(t_s=t_s, frame_index=frame_index,
                             present=False, observed=False,
                             track_id=primary.id, track_age=primary.age,
                             misses=primary.misses, n_candidates=len(self.tracks))

        return BallState(
            t_s=t_s, frame_index=frame_index,
            present=True, observed=last.observed,
            xy=primary.pos, vel_px_s=primary.vel / max(1e-6, self.dt),
            speed_px_s=primary.speed_px_s, conf=primary.last_conf,
            track_id=primary.id, track_age=primary.age, misses=primary.misses,
            n_candidates=len(self.tracks),
        )

    def _primary(self) -> Optional[BallTrack]:
        confirmed = [t for t in self.tracks if t.confirmed]
        if not confirmed:
            return None
        # Prefer the track that is currently observed; among those, best score.
        observed = [t for t in confirmed if t.misses == 0]
        pool = observed or confirmed
        return max(pool, key=lambda t: t.score)

    @property
    def primary_track(self) -> Optional[BallTrack]:
        return self._primary()

    def trail(self, n: int) -> List[BallObservation]:
        track = self._primary()
        return track.recent(n) if track else []
