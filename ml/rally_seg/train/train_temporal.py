"""Train the temporal segmentation model.

Grouped splits, always: consecutive frames from one match are near-duplicates,
so a random frame-level split reports a number that has nothing to do with how
the model will behave on the next video you upload.  Whole clips go to train or
to validation, never both.

The loss weights the two boundary heads far above the in-rally mask.  The mask
is easy -- a constant "yes" would score 60% on match footage -- and it is not
what the product needs.  What it needs is the exact frame the serve starts.
"""

from __future__ import annotations

import argparse
import os
from typing import List, Optional, Tuple

import numpy as np

from ..features import FEATURE_VERSION, N_FEATURES
from ..models.temporal import DEFAULT_DILATIONS, NormStats

try:
    import torch
    import torch.nn as nn
except ImportError as exc:  # pragma: no cover
    raise SystemExit("torch is required to train: pip install -r ml/requirements-yolo.txt") from exc

from ..models.temporal import RallyTCN


def make_windows(X: np.ndarray, Y: np.ndarray, group: np.ndarray,
                 window: int, stride: int) -> List[Tuple[np.ndarray, np.ndarray, int]]:
    out = []
    for g in np.unique(group):
        idx = np.where(group == g)[0]
        for s in range(0, max(1, len(idx) - window + 1), stride):
            sel = idx[s : s + window]
            if len(sel) < window:
                break
            out.append((X[sel], Y[sel], int(g)))
    return out


def train(dataset: str, out_path: str, epochs: int = 40, window: int = 900,
          stride: int = 150, hidden: int = 64, lr: float = 2e-3,
          val_groups: Optional[List[int]] = None, causal: bool = False,
          device: str = "cpu", seed: int = 0) -> str:
    torch.manual_seed(seed)
    np.random.seed(seed)

    data = np.load(dataset, allow_pickle=False)
    X, Y, group = data["X"].astype(np.float32), data["Y"].astype(np.float32), data["group"]
    if X.shape[1] != N_FEATURES:
        raise SystemExit(
            f"dataset has {X.shape[1]} features, this build produces {N_FEATURES}; "
            "re-export with the current code"
        )

    groups = sorted(np.unique(group).tolist())
    if val_groups is None:
        n_val = max(1, len(groups) // 5)
        val_groups = groups[-n_val:]
    train_groups = [g for g in groups if g not in val_groups]
    if not train_groups:
        raise SystemExit("no training clips left after the validation split")
    print(f"train clips {train_groups}   val clips {val_groups}")

    train_mask = np.isin(group, train_groups)
    norm = NormStats.fit(X[train_mask])
    Xn = norm.apply(X)

    train_w = make_windows(Xn, Y, group, window, stride)
    train_w = [w for w in train_w if w[2] in train_groups]
    val_w = [w for w in make_windows(Xn, Y, group, window, window) if w[2] in val_groups]
    if not train_w:
        raise SystemExit("no training windows; lower --window")
    print(f"{len(train_w)} train windows, {len(val_w)} val windows")

    model = RallyTCN(in_dim=N_FEATURES, hidden=hidden, dilations=DEFAULT_DILATIONS,
                     causal=causal).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)

    # Boundary frames are ~1% of the data; without pos_weight the model learns
    # to predict "no boundary" everywhere and calls it a day.
    pos_weight = torch.tensor([1.0, 40.0, 40.0], device=device)
    head_weight = torch.tensor([1.0, 3.0, 3.0], device=device)
    lossfn = nn.BCEWithLogitsLoss(pos_weight=pos_weight, reduction="none")

    best_val = float("inf")
    best_state = None
    for epoch in range(epochs):
        model.train()
        np.random.shuffle(train_w)
        total = 0.0
        for i in range(0, len(train_w), 8):
            batch = train_w[i : i + 8]
            xb = torch.from_numpy(np.stack([b[0] for b in batch])).to(device)
            yb = torch.from_numpy(np.stack([b[1] for b in batch])).to(device)
            logits = model(xb)
            loss = (lossfn(logits, yb) * head_weight).mean()
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            total += float(loss) * len(batch)
        sched.step()

        model.eval()
        val_total = 0.0
        with torch.no_grad():
            for i in range(0, len(val_w), 8):
                batch = val_w[i : i + 8]
                if not batch:
                    continue
                xb = torch.from_numpy(np.stack([b[0] for b in batch])).to(device)
                yb = torch.from_numpy(np.stack([b[1] for b in batch])).to(device)
                val_total += float((lossfn(model(xb), yb) * head_weight).mean()) * len(batch)
        train_loss = total / max(1, len(train_w))
        val_loss = val_total / max(1, len(val_w)) if val_w else float("nan")
        print(f"epoch {epoch + 1:3d}  train {train_loss:.4f}  val {val_loss:.4f}")
        if val_w and val_loss < best_val:
            best_val = val_loss
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}

    state = best_state or model.state_dict()
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    torch.save({
        "state_dict": state,
        "norm": norm.to_dict(),
        "feature_version": FEATURE_VERSION,
        "arch": {"in_dim": N_FEATURES, "hidden": hidden,
                 "dilations": list(DEFAULT_DILATIONS), "causal": causal},
        "val_loss": best_val,
    }, out_path)
    print(f"wrote {out_path} (best val {best_val:.4f})")
    return out_path


def main(argv: List[str] = None) -> int:
    p = argparse.ArgumentParser("rally_seg.train.train_temporal")
    p.add_argument("--dataset", required=True, help="npz from export_dataset")
    p.add_argument("--out", default="models/temporal_tcn.pt")
    p.add_argument("--epochs", type=int, default=40)
    p.add_argument("--window", type=int, default=900)
    p.add_argument("--stride", type=int, default=150)
    p.add_argument("--hidden", type=int, default=64)
    p.add_argument("--lr", type=float, default=2e-3)
    p.add_argument("--causal", action="store_true", help="train a streaming-capable model")
    p.add_argument("--device", default="cpu")
    p.add_argument("--val-groups", type=int, nargs="*")
    args = p.parse_args(argv)
    train(args.dataset, args.out, epochs=args.epochs, window=args.window, stride=args.stride,
          hidden=args.hidden, lr=args.lr, val_groups=args.val_groups, causal=args.causal,
          device=args.device)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
