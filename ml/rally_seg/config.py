"""Configuration.

Every threshold in the pipeline lives here, nowhere else.  That is a hard rule:
the calibration harness works by mutating a ``Config`` and re-running the
segmenter over a cached feature stream, so a threshold hidden inside a function
is a threshold that can never be tuned.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field, asdict, fields, is_dataclass
from typing import Any, Dict, Optional


@dataclass
class VideoConfig:
    """How frames are pulled off disk.

    ``stride`` is the single biggest speed lever.  Ball tracking wants every
    frame -- a pickleball crosses a 20 ft court in well under a second -- so
    stride 1 is the default and stride 2 is the most you should use on 60 fps
    footage.
    """

    stride: int = 1
    #: Longest edge the perception stack sees.  Detections are mapped back to
    #: full-resolution coordinates, so this only trades accuracy for speed.
    max_side: int = 1280
    start_s: float = 0.0
    end_s: Optional[float] = None
    #: Decode with ffmpeg piped rawvideo instead of cv2.VideoCapture.  Slower to
    #: start, but immune to the container/codec quirks that make OpenCV silently
    #: return the wrong frame count on phone footage.
    use_ffmpeg_reader: bool = False


@dataclass
class BallDetectorConfig:
    backend: str = "yolo"            # yolo | motion | replay | auto
    weights: str = "models/ball_yolo.pt"
    #: ``replay`` reads detections from a JSON file instead of running a model.
    #: Deterministic reruns, regression tests, and swapping in detections
    #: produced elsewhere (a GPU box, a different detector) without touching the
    #: rest of the pipeline.
    replay_path: Optional[str] = None
    conf: float = 0.15               # a pickleball is small and often blurred
    iou: float = 0.45
    imgsz: int = 960
    device: str = "auto"             # auto | cpu | cuda | mps
    half: bool = False
    max_det: int = 8
    class_id: int = 0
    batch_size: int = 8

    #: Tiled inference.  A ball 8 px across on a 1080p frame is ~4 px after the
    #: 640 px letterbox every YOLO does by default, which is below what the
    #: smallest stride-8 head can represent.  Cutting the frame into overlapping
    #: tiles and running each at native scale is what makes the recall usable.
    tiled: bool = True
    tile_rows: int = 2
    tile_cols: int = 2
    tile_overlap: float = 0.2
    #: Once a track exists, only search a window around the prediction.  Much
    #: faster than tiling and much more precise; falls back to a full sweep as
    #: soon as the track goes stale.
    roi_tracking: bool = True
    roi_size: int = 384
    roi_max_stale_frames: int = 6

    # --- motion fallback (used when no weights exist, and for smoke tests) ---
    motion_min_area: int = 4
    motion_max_area: int = 900
    motion_history: int = 200
    motion_var_threshold: float = 24.0

    #: Multiplier applied to a candidate's confidence when it falls inside a
    #: detected player box.  1.0 disables it.
    player_box_penalty: float = 0.45

    #: Reject detections that cannot belong to this court.  Public courts sit
    #: side by side, so a ball detector will happily find the neighbours' ball
    #: -- and a tracker with a generous gate will hop onto it.  Needs a fitted
    #: or calibrated court; without one, gating is skipped.
    court_gate: bool = True
    #: How far past each edge still counts as this court, as a fraction of the
    #: court's own width/length in the image.  Expressed as a fraction rather
    #: than in feet because it is applied in image space -- see
    #: pipeline._court_gate_polygon for why feet does not survive the maths.
    court_gate_margin_frac: float = 0.22
    #: Airspace above the far baseline, in pixels.  Generous: lobs go high.
    court_gate_sky_px: float = 400.0
    #: Slack below the near baseline, in pixels.
    court_gate_floor_px: float = 60.0


@dataclass
class PlayerDetectorConfig:
    backend: str = "yolo"            # yolo | motion
    weights: str = "yolov8n.pt"      # COCO; class 0 == person
    conf: float = 0.35
    #: Deliberately high.  NMS is suppressing *duplicate* people here, and
    #: doubles partners stand shoulder to shoulder and cross in front of each
    #: other constantly.  A low threshold deletes the back player of an
    #: overlapping pair, which the tracker then reports as a lost track.
    iou: float = 0.7
    imgsz: int = 640
    device: str = "auto"
    max_players: int = 4
    min_box_height_frac: float = 0.04
    #: Detection is expensive and people do not teleport; run it every Nth frame
    #: and let the tracker carry the boxes in between.
    detect_every: int = 3
    #: Drop people who are not standing on this court -- spectators, the queue
    #: behind the fence, the neighbours' game.  Tested on the feet.
    court_gate: bool = True
    court_margin_frac: float = 0.15
    #: The margin used when DECIDING who the players are, rather than when
    #: following them.  Much tighter than ``court_margin_frac`` on purpose: the
    #: loose gate runs to 1.6x the image height so a player at the camera is
    #: not lost, which also admits everyone standing behind the court.  This
    #: one is the painted quad plus a fourteenth of it, which is standing room
    #: behind a baseline for a serve and not much else.
    court_margin_strict_frac: float = 0.07


@dataclass
class TrackerConfig:
    """Player tracker (IoU + constant-velocity Kalman, ByteTrack-style two stage)."""

    high_thresh: float = 0.5
    low_thresh: float = 0.15
    match_iou: float = 0.25
    #: How far a player's feet may move, in body heights, and still be the same
    #: player.  Generous: this is a fallback for when IoU has already failed.
    match_distance_heights: float = 1.2
    #: Weight on the distance affinity relative to IoU.  Below 1 so a clean box
    #: overlap always wins over mere proximity.
    proximity_weight: float = 0.85
    #: Long enough to survive a full crossing.  A player who disappears behind
    #: their partner for a second and comes back must keep their identity, or
    #: the activity signal shows a spike that never happened.
    max_age: int = 45
    min_hits: int = 3


@dataclass
class BallTrackConfig:
    """Ball tracker.

    Constant-acceleration Kalman in image space with gravity folded into the
    y acceleration.  Gating is Mahalanobis so a fast ball gets a wide gate and a
    hovering dink gets a tight one.
    """

    max_coast_frames: int = 12       # how long a track survives with no detection
    #: Whether a coasting track reports its predicted position as if the ball
    #: were there.
    #:
    #: Off by default.  The filter still predicts one frame ahead internally --
    #: that is unavoidable, it is how the tracker decides which of several
    #: candidate blobs is the ball -- but a prediction is a guess, and a guess
    #: presented as a measurement is a lie the rest of the pipeline cannot
    #: detect.  With this off, a frame where the ball was not actually seen
    #: reports no ball: nothing drawn, no trail, no position in the features.
    report_predicted_positions: bool = False
    min_hits: int = 3                # detections before a track is "confirmed"
    gate_mahalanobis: float = 9.0
    #: Physical fallback gate, as a fraction of the furthest the ball could
    #: possibly have travelled in one frame.  A constant-velocity Kalman filter
    #: cannot predict an impulse, so at exactly the moments that matter -- a
    #: bounce, a paddle strike -- the statistical gate rejects the correct
    #: detection and the track is lost.  Accepting anything within reach keeps
    #: the track through the discontinuity; the filter re-converges in two or
    #: three frames.
    physical_gate_frac: float = 0.9
    process_noise: float = 30.0
    measurement_noise: float = 6.0
    gravity_px_s2: float = 900.0     # rescaled at runtime from court geometry
    #: Fallback speed gate in pixels, used only when there is no court.
    max_speed_px_s: float = 4000.0
    #: The real gate, in feet per second, applied via the court scale.  A hard
    #: pickleball drive is ~60 mph (88 ft/s); anything faster is the tracker
    #: jumping to a different ball, not a shot.
    max_speed_ft_s: float = 95.0
    #: The physical reacquisition window grows with the number of missed
    #: frames -- over N frames the ball can be N frames' travel away -- but the
    #: growth is capped.  Uncapped, a long occlusion opens the window wide
    #: enough to swallow a different ball entirely; capped at zero, the tracker
    #: can never pick the ball back up after it passes behind a player.
    coast_growth_max: int = 3
    #: Two balls on screen (adjacent court, a stray) are common.  Keep a few
    #: hypotheses and promote whichever accumulates the best score.
    max_hypotheses: int = 3
    hypothesis_decay: float = 0.9


@dataclass
class CourtConfig:
    backend: str = "classical"       # classical | keypoint | fixed | none
    weights: str = "models/court_kp.pt"
    #: Frames sampled across the video to fit the court.  The best-scoring fit
    #: wins; a static camera then reuses it for the whole video.
    fit_samples: int = 24
    refit_interval_s: float = 0.0    # 0 = fit once (static camera)
    min_line_support: float = 0.35
    white_threshold: int = 165
    #: Court lines are assumed white, which is what ``white_threshold`` above
    #: gates.  Set this to a ``"#rrggbb"`` sampled from the footage itself to
    #: fit courts whose lines are painted some other colour -- blue on a green
    #: surface, yellow on blue, black on concrete.  Empty means white, and
    #: takes the original bright-and-unsaturated path unchanged.
    #:
    #: A sampled colour beats a named one: paint fades, gym lighting is
    #: green-ish, and a phone camera white-balances the whole frame, so the
    #: "yellow" line in the footage is frequently nothing a colour picker
    #: would call yellow.
    line_color_hex: str = ""
    #: Lab distance within which a pixel counts as line paint.  Raise it for
    #: uneven lighting, lower it when the surface colour is close to the line
    #: colour.  Only used when ``line_color_hex`` is set.
    line_color_tolerance: float = 26.0
    #: How much lightness counts toward that distance, against a/b at 1.0.
    #: Below 1.0 because the same paint is darker in the net post's shadow
    #: than in sun while its a/b barely move; above 0 because lightness is
    #: the only thing separating white paint from grey concrete.
    line_color_lightness_weight: float = 0.5
    canny_low: int = 50
    canny_high: int = 150
    hough_threshold: int = 70
    hough_min_line_frac: float = 0.15
    hough_max_gap: int = 24
    #: How many line clusters, strongest first, enter the quad search.  The
    #: search is O(n^4) so this is the main cost knob; 12 is plenty when the
    #: court lines are the longest things in frame, and 16 helps on cluttered
    #: shots with neighbouring courts in view.
    max_candidate_lines: int = 12
    #: Smallest fraction of the frame a candidate court may occupy.
    min_area_frac: float = 0.06
    #: How hard to penalise white pixels where a correct fit predicts blank
    #: court.  Set to 0 to score purely on line support.
    negative_weight: float = 0.4
    #: "auto" tries the full court and the near half and keeps whichever scores
    #: better; "full" or "near_half" pins it.
    extent: str = "auto"
    #: Margin a near-half fit must beat the full-court fit by.
    half_court_penalty: float = 0.10
    #: Penalty applied when a candidate makes the *short* image edge the
    #: baseline.  Encodes "the camera is behind a baseline"; set to 0 for
    #: side-on footage.
    long_edge_prior: float = 0.15
    #: Candidate fits scoring at least this fraction of the best one take part
    #: in the consensus vote.
    consensus_score_frac: float = 0.75
    #: Mean corner distance, in pixels, within which two fits count as the same.
    consensus_tolerance_px: float = 30.0
    #: Minimum fraction of fitted frames that must agree before the geometry is
    #: trusted.  A court that different frames disagree about is not a court
    #: that was found -- it is one the scorer got lucky on once.  Below this the
    #: fit is discarded and the pipeline says so, rather than quietly producing
    #: confident-looking coordinates from a wrong homography.
    min_agreement: float = 0.20
    #: The agreement fraction alone is a poor gate, because it is diluted by
    #: frames that fitted *something else badly* -- a player standing on the
    #: baseline, a shadow across the kitchen -- not by frames that found a
    #: different court.  A quad that several independent frames converge on and
    #: that explains most of the paint it predicts is real evidence even when
    #: it is a minority of samples.  So a fit also passes when at least
    #: ``min_consensus_frames`` frames agree on it *and* its line support
    #: reaches ``strong_support``.  Measured on real footage: the correct fit on
    #: a low-tripod clip came in at 18% agreement, 4 frames, 0.63 support --
    #: within 10 px of the hand-marked corners, and rejected by the old gate.
    min_consensus_frames: int = 3
    strong_support: float = 0.50
    #: Fall back to an image-space net line at this height fraction when the
    #: court cannot be fitted, so net-crossing still produces a usable signal.
    fallback_net_y_frac: float = 0.52
    #: Tolerance, in feet, before a ball landing outside the lines is called out.
    out_margin_ft: float = 0.6
    #: JSON file with four image-space court corners, clockwise from the
    #: near-left baseline corner.  Used by ``backend: fixed``; also a rescue
    #: hatch when automatic fitting fails on unusual camera angles.
    manual_points_path: Optional[str] = None
    #: Singles and doubles are played on the same 20x44 court in pickleball,
    #: with the same lines -- there is no singles sideline as there is in
    #: tennis.  So this changes nothing about court fitting, and nothing here
    #: reads it.  What the distinction does change is how many people are on
    #: court, which is ``players.max_players``, not a court setting at all.
    #: Kept only so an existing config naming it does not fail to load.
    doubles: bool = True


@dataclass
class EventConfig:
    """Thresholds for the discrete events the state machine reasons over."""

    # Impulses.  A bounce and a paddle contact are the same measurement -- an
    # abrupt change in velocity -- separated afterwards by what kind of change
    # it was.  Detecting them together is what makes both robust: a ball flying
    # toward the camera has a monotonically increasing image y even across a
    # bounce, so any rule phrased as "a peak in image y" silently loses most of
    # the bounces in a match.
    impulse_min_px_s: float = 150.0     # absolute velocity change
    impulse_rel: float = 0.45           # ... and relative to the incoming speed
    bounce_min_speed_px_s: float = 70.0 # minimum downward speed before a bounce
    bounce_window: int = 3
    #: A velocity change this close to a player box is read as a paddle, not a
    #: bounce.  Only used when player tracking is actually producing boxes.
    contact_player_margin_px: float = 26.0
    #: Minimum seconds between two impulses of the same kind.
    impulse_cooldown_s: float = 0.12
    #: A ball this slow cannot have been struck or bounced hard enough to
    #: matter.  Without this floor, a ball rolling to a stop after the point
    #: generates a stream of phantom contacts -- which then read as "play
    #: resumed" and keep the rally open for seconds after it ended.
    impulse_min_speed_px_s: float = 190.0
    #: Ball is "low" (near the playing surface) below this court-height proxy.
    ground_height_frac: float = 0.12

    # Net crossing.
    net_cross_min_dx_px: float = 6.0
    net_cross_cooldown_frames: int = 4

    # Net contact: ball reaches the net band, then loses most of its speed and
    # falls, without a crossing.
    net_contact_band_px: float = 28.0
    net_contact_speed_drop: float = 0.45
    net_contact_window: int = 8

    # Out of bounds: extrapolated landing point outside the court polygon.
    out_lookahead_frames: int = 20
    out_min_confidence: float = 0.5

    # Serve: both sides settled, one player behind the baseline, ball rises from
    # low and crosses the net, preceded by a quiet stretch.
    #: A serve is preceded by this long with no contact and no net crossing.
    #: Set above the longest mid-rally lull (a high lob is about a second) and
    #: below the shortest gap between points, which is several.
    serve_quiet_window_s: float = 1.3
    serve_max_prior_activity: float = 0.18
    serve_min_rise_px_s: float = 120.0
    serve_baseline_frac: float = 0.15


@dataclass
class StateMachineConfig:
    """Hysteresis rally state machine.

    The two thresholds are deliberately asymmetric: it takes more evidence to
    start a rally than to keep one alive.  That asymmetry, plus
    ``max_ball_gap_s``, is what stops a half-second occlusion from cutting one
    rally into three.
    """

    start_threshold: float = 0.55
    stop_threshold: float = 0.30
    #: After a rally ends, start evidence must fall below this before another
    #: rally may open.  Genuine hysteresis, and the thing that stops one point
    #: from being reported as two.
    rearm_threshold: float = 0.42
    start_hold_frames: int = 4       # sustained evidence before committing
    stop_hold_frames: int = 10

    #: Ball may vanish this long mid-rally without ending it -- as long as the
    #: players are still moving.  This is the single most important knob.
    max_ball_gap_s: float = 1.1
    #: ... unless player activity also collapses, in which case a much shorter
    #: gap is enough to call it.
    quiet_ball_gap_s: float = 0.5
    quiet_activity_threshold: float = 0.12

    min_rally_s: float = 1.2
    max_rally_s: float = 90.0
    #: Two segments closer than this are the same rally seen through a dropout.
    merge_gap_s: float = 0.9

    #: Padding applied after boundary snapping, so clips do not start on the
    #: exact frame of contact.
    lead_s: float = 0.45
    tail_s: float = 0.70

    # Evidence weights -- start.
    w_start_serve: float = 1.0
    w_start_net_cross: float = 0.55
    w_start_ball_motion: float = 0.45
    w_start_player_activity: float = 0.30

    # Evidence weights -- end.
    w_end_out: float = 1.0
    w_end_net_contact: float = 0.85
    w_end_ground: float = 0.75
    w_end_occlusion: float = 0.60
    w_end_next_serve: float = 0.95
    #: Raised deliberately: with the stationary-ball case folded in, "nobody is
    #: moving and the ball is lying there" is strong evidence, not weak.
    w_end_low_activity: float = 0.55

    #: How far back the end boundary is allowed to snap to the terminating
    #: event once the machine has confirmed the end.
    end_snap_window_s: float = 2.5

    #: A terminating event opens a confirmation window rather than ending the
    #: rally outright.  If play visibly resumes inside it -- a net crossing or a
    #: paddle contact -- the event was a false positive and the rally continues,
    #: with the boundary unmoved.  Short enough not to blunt the timestamp,
    #: because the end is always snapped back to the event itself.
    end_confirm_s: float = 0.45
    #: A rally must have run this long before a terminating event may close it.
    #: Stops the serve's own bounce from ending the rally it just started.
    min_established_s: float = 0.8
    #: Impulse events (a serve, a net crossing) are single frames.  They are held
    #: with exponential decay over this many seconds so that sustained-evidence
    #: thresholds can see them at all.
    evidence_decay_s: float = 1.2


@dataclass
class SegmenterConfig:
    kind: str = "rule_based"         # rule_based | temporal | ensemble
    temporal_weights: str = "models/temporal_tcn.pt"
    #: With ``ensemble``: blend of learned per-frame rally probability and the
    #: rule-based score, 0 = pure rules, 1 = pure model.
    ensemble_alpha: float = 0.5


@dataclass
class DebugConfig:
    trail_frames: int = 45
    draw_court: bool = True
    draw_players: bool = True
    draw_ball: bool = True
    draw_timeline: bool = True
    draw_evidence: bool = True
    font_scale: float = 0.55
    crf: int = 23
    preset: str = "veryfast"


@dataclass
class Config:
    video: VideoConfig = field(default_factory=VideoConfig)
    ball: BallDetectorConfig = field(default_factory=BallDetectorConfig)
    players: PlayerDetectorConfig = field(default_factory=PlayerDetectorConfig)
    tracker: TrackerConfig = field(default_factory=TrackerConfig)
    ball_track: BallTrackConfig = field(default_factory=BallTrackConfig)
    court: CourtConfig = field(default_factory=CourtConfig)
    events: EventConfig = field(default_factory=EventConfig)
    state: StateMachineConfig = field(default_factory=StateMachineConfig)
    segmenter: SegmenterConfig = field(default_factory=SegmenterConfig)
    debug: DebugConfig = field(default_factory=DebugConfig)

    #: Optional JSON file of audio paddle-contact timestamps, e.g. produced by
    #: the app's existing audio segmenter.  Folded in as one more feature
    #: channel; the pipeline is fully functional without it.
    audio_contacts_path: Optional[str] = None
    cache_dir: str = ".rally_cache"
    seed: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def digest(self) -> str:
        blob = json.dumps(self.to_dict(), sort_keys=True).encode()
        return hashlib.sha1(blob).hexdigest()[:12]

    def perception_digest(self) -> str:
        """Hash of only the parts that affect the cached feature stream.

        Changing a state-machine threshold must not invalidate an hour of
        perception; changing the ball detector must.
        """
        sub = {
            "video": asdict(self.video),
            "ball": asdict(self.ball),
            "players": asdict(self.players),
            "tracker": asdict(self.tracker),
            "ball_track": asdict(self.ball_track),
            "court": asdict(self.court),
            "events": asdict(self.events),
            "audio": self.audio_contacts_path,
        }
        return hashlib.sha1(json.dumps(sub, sort_keys=True).encode()).hexdigest()[:12]

    # --- construction -----------------------------------------------------

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Config":
        cfg = cls()
        _merge_into(cfg, d or {})
        return cfg

    def override(self, dotted: Dict[str, Any]) -> "Config":
        """Apply ``{"state.max_ball_gap_s": 1.4}`` style overrides in place."""
        for key, value in dotted.items():
            _set_dotted(self, key, value)
        return self

    def get_dotted(self, key: str) -> Any:
        node: Any = self
        for part in key.split("."):
            node = getattr(node, part)
        return node

    def copy(self) -> "Config":
        return Config.from_dict(self.to_dict())


def _merge_into(node: Any, data: Dict[str, Any]) -> None:
    valid = {f.name: f for f in fields(node)}
    for key, value in data.items():
        if key not in valid:
            raise KeyError(f"unknown config key: {key}")
        current = getattr(node, key)
        if is_dataclass(current) and isinstance(value, dict):
            _merge_into(current, value)
        else:
            setattr(node, key, value)


def _set_dotted(node: Any, key: str, value: Any) -> None:
    parts = key.split(".")
    for part in parts[:-1]:
        node = getattr(node, part)
    leaf = parts[-1]
    if not hasattr(node, leaf):
        raise KeyError(f"unknown config key: {key}")
    current = getattr(node, leaf)
    if isinstance(value, str) and current is not None:
        # YAML/CLI strings arrive untyped; coerce to whatever the default is.
        if isinstance(current, bool):
            value = value.strip().lower() in ("1", "true", "yes", "on")
        elif isinstance(current, int) and not isinstance(current, bool):
            value = int(float(value))
        elif isinstance(current, float):
            value = float(value)
    setattr(node, leaf, value)


def load_config(path: Optional[str] = None, overrides: Optional[Dict[str, Any]] = None) -> Config:
    """Defaults <- YAML/JSON file <- RALLYSEG_* env vars <- explicit overrides."""
    data: Dict[str, Any] = {}
    if path:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
        if path.endswith((".yaml", ".yml")):
            try:
                import yaml  # type: ignore
            except ImportError as exc:  # pragma: no cover
                raise RuntimeError("PyYAML is required to read .yaml configs") from exc
            data = yaml.safe_load(text) or {}
        else:
            data = json.loads(text or "{}")

    cfg = Config.from_dict(data)

    env_overrides: Dict[str, Any] = {}
    for name, value in os.environ.items():
        if not name.startswith("RALLYSEG_"):
            continue
        # RALLYSEG_STATE__MAX_BALL_GAP_S -> state.max_ball_gap_s
        dotted = name[len("RALLYSEG_") :].lower().replace("__", ".")
        env_overrides[dotted] = value
    if env_overrides:
        cfg.override(env_overrides)

    if overrides:
        cfg.override(overrides)
    return cfg
