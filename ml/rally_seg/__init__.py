"""Vision-based pickleball rally segmentation.

The pipeline turns a match video into precise rally start/end timestamps with
per-boundary confidence.  It is deliberately split into three layers:

    perception  ->  feature stream  ->  segmenter

Only the middle layer is a contract.  ``FeatureFrame`` (see ``features.py``) is
a fixed-width numeric vector produced once per video frame; every segmenter --
the hand-written state machine in ``models/rule_based.py`` and the learned
temporal model in ``models/temporal.py`` -- consumes exactly that stream and
nothing else.  That is what makes the rule-based detector replaceable rather
than load-bearing.
"""

__version__ = "1.0.0"

from .schema import (
    RallySegment,
    SegmentationResult,
    EndReason,
    StartReason,
    SCHEMA_VERSION,
)
from .config import Config, load_config

__all__ = [
    "__version__",
    "SCHEMA_VERSION",
    "Config",
    "load_config",
    "RallySegment",
    "SegmentationResult",
    "EndReason",
    "StartReason",
]
