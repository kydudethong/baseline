"""The feature stream -- the contract between perception and segmentation.

This is the seam the whole design hangs on.  Perception is expensive and
model-dependent; segmentation is cheap and opinionated.  By forcing both the
hand-written state machine and any learned temporal model to consume exactly
this fixed-width per-frame vector, three things become true:

* swapping the segmenter changes one line of config, not the pipeline;
* threshold calibration re-runs in milliseconds against a cached stream instead
  of re-decoding an hour of video;
* training data for the temporal model is a byproduct of ordinary inference --
  run the pipeline, label the rallies, and the features are already on disk.

Add features by appending to ``FEATURE_NAMES``, never by inserting, and bump
``FEATURE_VERSION``.  A checkpoint records the version it was trained against
and refuses to load against a different one.
"""

from __future__ import annotations

import json
import os
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Dict, List, Optional, Sequence, Tuple

import numpy as np

from .detect.court import COURT_L, COURT_W, NET_Y, CourtModel
from .events import (
    BALL_ROLL, BOUNCE, DOUBLE_BOUNCE, NET_CONTACT, NET_CROSS,
    OUT_OF_BOUNDS, PADDLE_CONTACT, SERVE, Event,
)
from .track.ball_track import BallState
from .track.bytetrack import Track
from .events import player_activity

FEATURE_VERSION = 1

FEATURE_NAMES: List[str] = [
    # --- ball presence ---
    "ball_present",          # a confirmed track exists (observed or coasting)
    "ball_observed",         # a detection landed on it this frame
    "ball_conf",
    "gap_norm",              # seconds since last observation / max_gap_reference
    # --- ball motion (image space, normalised by frame height) ---
    "ball_speed",
    "ball_vx",
    "ball_vy",
    "ball_x",                # 0..1 across the frame
    "ball_y",                # 0..1 down the frame
    # --- ball in court space (zeros when no homography) ---
    "court_valid",
    "ball_court_x",          # 0..1 across the 20 ft width
    "ball_court_y",          # 0..1 along the 44 ft length
    "ball_side",             # -1 near, +1 far, 0 unknown
    "ball_out_margin",       # feet outside the lines, clipped to 1.0 at 5 ft
    # --- discrete events, as impulses ---
    "ev_serve",
    "ev_net_cross",
    "ev_bounce",
    "ev_contact",
    "ev_net_contact",
    "ev_out",
    "ev_double_bounce",
    "ev_roll",
    # --- windowed event rates (per second, over `rate_window_s`) ---
    "rate_net_cross",
    "rate_contact",
    "rate_bounce",
    # --- players ---
    "n_players",             # /4
    "player_activity",
    "player_activity_w",     # smoothed over `activity_window_s`
    "player_spread",
    "max_player_speed",
    "deep_player",
    # --- fallbacks and side channels ---
    "motion_energy",         # global frame difference: alive even with no detector
    "audio_contact",         # optional paddle-impact channel from the audio segmenter
    "court_conf",
]

FEATURE_INDEX: Dict[str, int] = {name: i for i, name in enumerate(FEATURE_NAMES)}
N_FEATURES = len(FEATURE_NAMES)

#: Seconds of ball absence that maps ``gap_norm`` to 1.0.  Fixed so the feature
#: means the same thing regardless of the state machine's tolerance setting.
GAP_REFERENCE_S = 2.0

#: Overlay arrays are fixed-width so they round-trip through npz cleanly.
MAX_OVERLAY_PLAYERS = 6


@dataclass
class FeatureStream:
    """Per-frame features for a whole video, plus everything needed to explain them."""

    fps: float
    width: int
    height: int
    t: np.ndarray                       # (N,) seconds
    frame_index: np.ndarray             # (N,) source frame numbers
    X: np.ndarray                       # (N, N_FEATURES) float32
    events: List[Event] = field(default_factory=list)
    court: Optional[dict] = None
    feature_version: int = FEATURE_VERSION
    meta: Dict[str, object] = field(default_factory=dict)

    #: Overlay payload, so the debug renderer is a pure function of the cache
    #: and never has to re-run a detector.  ``ball_xy`` is (N, 3): x, y, observed
    #: (NaN where there is no track).  ``players`` is (N, MAX_OVERLAY_PLAYERS, 5):
    #: x1, y1, x2, y2, track_id, zero-filled.
    ball_xy: np.ndarray = field(default_factory=lambda: np.zeros((0, 3), dtype=np.float32))
    players: np.ndarray = field(default_factory=lambda: np.zeros((0, MAX_OVERLAY_PLAYERS, 5), dtype=np.float32))

    def __len__(self) -> int:
        return int(self.X.shape[0])

    def col(self, name: str) -> np.ndarray:
        return self.X[:, FEATURE_INDEX[name]]

    def index_at(self, t_s: float) -> int:
        if len(self) == 0:
            return 0
        return int(np.clip(np.searchsorted(self.t, t_s), 0, len(self) - 1))

    def events_between(self, t0: float, t1: float, kinds: Optional[Sequence[str]] = None) -> List[Event]:
        out = [e for e in self.events if t0 <= e.t_s <= t1]
        if kinds is not None:
            out = [e for e in out if e.kind in kinds]
        return out

    # --- persistence ------------------------------------------------------

    def save(self, path: str) -> str:
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        np.savez_compressed(
            path,
            t=self.t.astype(np.float64),
            frame_index=self.frame_index.astype(np.int64),
            X=self.X.astype(np.float32),
            ball_xy=self.ball_xy.astype(np.float32),
            players=self.players.astype(np.float32),
            sidecar=np.frombuffer(json.dumps({
                "fps": self.fps, "width": self.width, "height": self.height,
                "feature_version": self.feature_version,
                "feature_names": FEATURE_NAMES,
                "court": self.court,
                "meta": self.meta,
                "events": [
                    {"kind": e.kind, "t_s": e.t_s, "frame_index": e.frame_index,
                     "confidence": e.confidence, "detail": e.detail}
                    for e in self.events
                ],
            }).encode("utf-8"), dtype=np.uint8),
        )
        return path

    @classmethod
    def load(cls, path: str) -> "FeatureStream":
        data = np.load(path, allow_pickle=False)
        side = json.loads(bytes(data["sidecar"]).decode("utf-8"))
        if side.get("feature_version") != FEATURE_VERSION:
            raise ValueError(
                f"feature cache {path} was written with feature_version "
                f"{side.get('feature_version')}, this build expects {FEATURE_VERSION}"
            )
        events = [
            Event(e["kind"], float(e["t_s"]), int(e["frame_index"]),
                  float(e.get("confidence", 1.0)), e.get("detail", {}))
            for e in side.get("events", [])
        ]
        return cls(
            fps=float(side["fps"]), width=int(side["width"]), height=int(side["height"]),
            t=data["t"], frame_index=data["frame_index"], X=data["X"],
            events=events, court=side.get("court"),
            feature_version=int(side["feature_version"]), meta=side.get("meta", {}),
            ball_xy=data["ball_xy"] if "ball_xy" in data.files else np.zeros((0, 3), np.float32),
            players=data["players"] if "players" in data.files
            else np.zeros((0, MAX_OVERLAY_PLAYERS, 5), np.float32),
        )


class FeatureBuilder:
    """Accumulates one ``FeatureStream`` as the pipeline walks the video."""

    def __init__(self, fps: float, width: int, height: int, court,
                 rate_window_s: float = 2.0, activity_window_s: float = 1.0,
                 audio_contacts: Optional[Sequence[float]] = None):
        self.fps = max(1e-6, fps)
        self.width = width
        self.height = height
        self.court = court
        self.has_court = isinstance(court, CourtModel)
        self.rate_window_s = rate_window_s
        self.activity_window_s = activity_window_s
        self.audio_contacts = sorted(audio_contacts or [])
        self._audio_cursor = 0

        self._rows: List[np.ndarray] = []
        self._t: List[float] = []
        self._idx: List[int] = []
        self._events: List[Event] = []
        self._ball_xy: List[np.ndarray] = []
        self._players: List[np.ndarray] = []

        self._event_times: Dict[str, Deque[float]] = {
            NET_CROSS: deque(), PADDLE_CONTACT: deque(), BOUNCE: deque(),
        }
        self._activity: Deque[Tuple[float, float]] = deque(maxlen=600)
        self._last_obs_t: Optional[float] = None
        self._prev_gray: Optional[np.ndarray] = None

    # --- per frame ---------------------------------------------------------

    def add(self, t_s: float, frame_index: int, ball: BallState,
            players: Sequence[Track], events: Sequence[Event],
            gray: Optional[np.ndarray] = None) -> np.ndarray:
        self._events.extend(events)
        kinds = {e.kind for e in events}
        for kind in (NET_CROSS, PADDLE_CONTACT, BOUNCE):
            if kind in kinds:
                self._event_times[kind].append(t_s)
            while self._event_times[kind] and t_s - self._event_times[kind][0] > self.rate_window_s:
                self._event_times[kind].popleft()

        row = np.zeros(N_FEATURES, dtype=np.float32)

        def put(name: str, value: float) -> None:
            row[FEATURE_INDEX[name]] = float(value)

        # --- ball ---
        if ball.observed:
            self._last_obs_t = t_s
        gap_s = (t_s - self._last_obs_t) if self._last_obs_t is not None else GAP_REFERENCE_S
        put("ball_present", 1.0 if ball.present else 0.0)
        put("ball_observed", 1.0 if ball.observed else 0.0)
        put("ball_conf", ball.conf)
        put("gap_norm", np.clip(gap_s / GAP_REFERENCE_S, 0.0, 1.0))

        if ball.present and ball.xy is not None:
            h = max(1.0, float(self.height))
            put("ball_x", np.clip(ball.xy[0] / max(1.0, self.width), -0.5, 1.5))
            put("ball_y", np.clip(ball.xy[1] / h, -0.5, 1.5))
            if ball.vel_px_s is not None:
                put("ball_vx", np.clip(ball.vel_px_s[0] / h, -20.0, 20.0))
                put("ball_vy", np.clip(ball.vel_px_s[1] / h, -20.0, 20.0))
            put("ball_speed", np.clip(ball.speed_px_s / h, 0.0, 20.0))

            if self.has_court:
                pt = self.court.to_court(ball.xy.reshape(1, 2))[0]
                if np.all(np.isfinite(pt)):
                    put("court_valid", 1.0)
                    put("ball_court_x", np.clip(pt[0] / COURT_W, -1.0, 2.0))
                    put("ball_court_y", np.clip(pt[1] / COURT_L, -1.0, 2.0))
                    put("ball_side", -1.0 if pt[1] < NET_Y else 1.0)
                    outside = max(-pt[0], pt[0] - COURT_W, -pt[1], pt[1] - COURT_L, 0.0)
                    put("ball_out_margin", np.clip(outside / 5.0, 0.0, 1.0))

        # --- events as impulses ---
        put("ev_serve", _impulse(events, SERVE))
        put("ev_net_cross", _impulse(events, NET_CROSS))
        put("ev_bounce", _impulse(events, BOUNCE))
        put("ev_contact", _impulse(events, PADDLE_CONTACT))
        put("ev_net_contact", _impulse(events, NET_CONTACT))
        put("ev_out", _impulse(events, OUT_OF_BOUNDS))
        put("ev_double_bounce", _impulse(events, DOUBLE_BOUNCE))
        put("ev_roll", _impulse(events, BALL_ROLL))

        window = max(1e-6, self.rate_window_s)
        put("rate_net_cross", len(self._event_times[NET_CROSS]) / window)
        put("rate_contact", len(self._event_times[PADDLE_CONTACT]) / window)
        put("rate_bounce", len(self._event_times[BOUNCE]) / window)

        # --- players ---
        act = player_activity(players, (self.width, self.height), self.fps)
        self._activity.append((t_s, act))
        recent = [a for (t, a) in self._activity if t_s - t <= self.activity_window_s]
        put("n_players", min(1.0, len(players) / 4.0))
        put("player_activity", act)
        put("player_activity_w", float(np.mean(recent)) if recent else 0.0)
        if len(players) >= 2:
            pts = np.array([p.feet for p in players], dtype=np.float32)
            spread = float(np.std(pts[:, 0]) + np.std(pts[:, 1])) / max(1.0, self.height)
            put("player_spread", np.clip(spread, 0.0, 2.0))
        if players:
            put("max_player_speed", np.clip(
                max((p.speed_px * self.fps) / max(8.0, float(p.x[3])) for p in players) / 4.0,
                0.0, 1.0))
            put("deep_player", 1.0 if self._deep_player(players) else 0.0)

        # --- side channels ---
        if gray is not None:
            put("motion_energy", self._motion_energy(gray))
        put("audio_contact", self._audio_impulse(t_s))
        put("court_conf", float(getattr(self.court, "confidence", 0.0) or 0.0))

        self._rows.append(row)
        self._t.append(t_s)
        self._idx.append(frame_index)

        if ball.present and ball.xy is not None:
            self._ball_xy.append(np.array(
                [ball.xy[0], ball.xy[1], 1.0 if ball.observed else 0.0], dtype=np.float32))
        else:
            self._ball_xy.append(np.array([np.nan, np.nan, 0.0], dtype=np.float32))

        pbuf = np.zeros((MAX_OVERLAY_PLAYERS, 5), dtype=np.float32)
        for slot, p in enumerate(players[:MAX_OVERLAY_PLAYERS]):
            box = p.xyxy
            pbuf[slot] = [box[0], box[1], box[2], box[3], float(p.id)]
        self._players.append(pbuf)

        return row

    # --- helpers -----------------------------------------------------------

    def _deep_player(self, players: Sequence[Track]) -> bool:
        if self.has_court:
            for p in players:
                pt = self.court.to_court(p.feet.reshape(1, 2))[0]
                if np.all(np.isfinite(pt)) and min(pt[1], COURT_L - pt[1]) <= 0.15 * COURT_L:
                    return True
            return False
        return any(p.feet[1] > 0.85 * self.height or p.feet[1] < 0.30 * self.height for p in players)

    def _motion_energy(self, gray: np.ndarray) -> float:
        if self._prev_gray is None or self._prev_gray.shape != gray.shape:
            self._prev_gray = gray
            return 0.0
        diff = np.abs(gray.astype(np.int16) - self._prev_gray.astype(np.int16))
        self._prev_gray = gray
        return float(np.clip(diff.mean() / 12.0, 0.0, 1.0))

    def _audio_impulse(self, t_s: float) -> float:
        if not self.audio_contacts:
            return 0.0
        tol = 1.5 / self.fps
        while (self._audio_cursor < len(self.audio_contacts)
               and self.audio_contacts[self._audio_cursor] < t_s - tol):
            self._audio_cursor += 1
        if (self._audio_cursor < len(self.audio_contacts)
                and abs(self.audio_contacts[self._audio_cursor] - t_s) <= tol):
            return 1.0
        return 0.0

    # --- finish ------------------------------------------------------------

    def build(self, meta: Optional[Dict[str, object]] = None) -> FeatureStream:
        X = (np.stack(self._rows).astype(np.float32) if self._rows
             else np.zeros((0, N_FEATURES), dtype=np.float32))
        court_dict = self.court.to_dict() if hasattr(self.court, "to_dict") else None
        return FeatureStream(
            fps=self.fps, width=self.width, height=self.height,
            t=np.array(self._t, dtype=np.float64),
            frame_index=np.array(self._idx, dtype=np.int64),
            X=X, events=list(self._events), court=court_dict,
            meta=meta or {},
            ball_xy=(np.stack(self._ball_xy).astype(np.float32) if self._ball_xy
                     else np.zeros((0, 3), dtype=np.float32)),
            players=(np.stack(self._players).astype(np.float32) if self._players
                     else np.zeros((0, MAX_OVERLAY_PLAYERS, 5), dtype=np.float32)),
        )


def _impulse(events: Sequence[Event], kind: str) -> float:
    best = 0.0
    for e in events:
        if e.kind == kind:
            best = max(best, float(e.confidence))
    return best


def load_audio_contacts(path: Optional[str]) -> List[float]:
    """Read paddle-contact timestamps produced by the app's audio segmenter.

    Accepts either ``[1.2, 3.4]`` or ``{"contacts": [{"t_s": 1.2}, ...]}``.
    """
    if not path or not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        data = data.get("contacts", [])
    out: List[float] = []
    for item in data:
        if isinstance(item, (int, float)):
            out.append(float(item))
        elif isinstance(item, dict):
            for key in ("t_s", "t", "time", "seconds"):
                if key in item:
                    out.append(float(item[key]))
                    break
    return sorted(out)
