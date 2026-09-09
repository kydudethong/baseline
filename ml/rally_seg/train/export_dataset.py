"""Turn labelled videos into a training set for the temporal segmenter.

Deliberately a thin script: the features are already produced by ordinary
inference and already cached, so building a dataset is running the pipeline over
footage you have labelled and writing the labels alongside.  That means every
minute of video you segment in production is a minute of potential training
data -- collect labels as you review, and the model trains itself into
existence.

Labels are three per-frame targets:

    rally  1 inside a labelled rally
    start  a narrow Gaussian bump on each start boundary
    end    the same on each end boundary

Bumps rather than single hot frames: a boundary that is one frame off is not
wrong in the way a boundary two seconds off is wrong, and a hard one-hot target
makes the loss dominated by an ambiguity nobody can label consistently.
"""

from __future__ import annotations

import argparse
import os
from typing import List, Sequence, Tuple

import numpy as np

from ..config import load_config
from ..evaluate import Interval, load_ground_truth
from ..features import FeatureStream
from ..pipeline import build_features

#: Half-width of the boundary bump, in seconds.
BOUNDARY_SIGMA_S = 0.20


def make_labels(stream: FeatureStream, truth: Sequence[Interval],
                sigma_s: float = BOUNDARY_SIGMA_S) -> np.ndarray:
    n = len(stream)
    y = np.zeros((n, 3), dtype=np.float32)
    if n == 0:
        return y
    t = stream.t
    for iv in truth:
        inside = (t >= iv.start_s) & (t <= iv.end_s)
        y[inside, 0] = 1.0
        y[:, 1] = np.maximum(y[:, 1], np.exp(-0.5 * ((t - iv.start_s) / sigma_s) ** 2))
        y[:, 2] = np.maximum(y[:, 2], np.exp(-0.5 * ((t - iv.end_s) / sigma_s) ** 2))
    return y


def export(pairs: Sequence[Tuple[str, str]], out_path: str, config_path: str = None,
           overrides=None) -> str:
    cfg = load_config(config_path, overrides)
    Xs, Ys, groups, names = [], [], [], []
    for gi, (video, labels) in enumerate(pairs):
        stream, _info = build_features(video, cfg, use_cache=True)
        truth = load_ground_truth(labels)
        Xs.append(stream.X.astype(np.float32))
        Ys.append(make_labels(stream, truth))
        groups.append(np.full(len(stream), gi, dtype=np.int32))
        names.append(os.path.basename(video))
        print(f"{video}: {len(stream)} frames, {len(truth)} rallies")

    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    np.savez_compressed(
        out_path,
        X=np.concatenate(Xs) if Xs else np.zeros((0, 0), np.float32),
        Y=np.concatenate(Ys) if Ys else np.zeros((0, 3), np.float32),
        group=np.concatenate(groups) if groups else np.zeros((0,), np.int32),
        names=np.array(names),
    )
    print(f"wrote {out_path}")
    return out_path


def main(argv: List[str] = None) -> int:
    p = argparse.ArgumentParser("rally_seg.train.export_dataset")
    p.add_argument("--clips", nargs="+", required=True, metavar="video.mp4:labels.json")
    p.add_argument("--out", required=True)
    p.add_argument("--config")
    args = p.parse_args(argv)
    pairs = []
    for spec in args.clips:
        video, labels = spec.rsplit(":", 1)
        pairs.append((video, labels))
    export(pairs, args.out, args.config)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
