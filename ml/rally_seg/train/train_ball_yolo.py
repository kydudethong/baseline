"""Train the pickleball ball detector.

Written for a Roboflow export in YOLO format.  The defaults here are not
Ultralytics defaults -- they are the ones that matter for a 74 mm ball filmed
from 30 feet away, and each is a deliberate departure:

``imgsz`` **960, not 640.**  The single highest-leverage change.  Detection
heads work on strides of 8, 16 and 32; a ball that is 8 px wide in the source is
2.7 px at 640 and simply cannot be represented by the stride-8 head.

``scale`` **low, ``mosaic`` off late.**  Aggressive scale augmentation teaches
the model to find balls at sizes that never occur in your footage, at the cost
of the size that does.  Mosaic helps early and hurts the last few epochs, where
the model should see whole frames laid out the way inference will see them.

``hsv_v`` **high.**  Outdoor courts go from full sun to deep shadow inside one
rally; indoor gyms flicker.  Value jitter is the augmentation that pays.

``flipud`` **off.**  Gravity has a direction and the model can use it.

The other half of accuracy is the dataset, and no hyperparameter recovers a bad
one.  Label the blurred smears, not only the crisp balls -- a detector that has
only seen sharp balls fails exactly when the ball is moving, which is every
frame that matters.  Include frames with no ball at all (behind a body, out of
shot) as negatives, or the model learns to always find something.
"""

from __future__ import annotations

import argparse
import os
from typing import List, Optional

DEFAULT_HYP = dict(
    imgsz=960,
    epochs=120,
    batch=16,
    patience=25,
    optimizer="AdamW",
    lr0=1.5e-3,
    lrf=0.01,
    warmup_epochs=3.0,
    cos_lr=True,
    # --- augmentation tuned for a small, fast, motion-blurred object ---
    hsv_h=0.012,
    hsv_s=0.55,
    hsv_v=0.55,
    degrees=3.0,
    translate=0.08,
    scale=0.25,
    shear=1.0,
    perspective=0.0,
    flipud=0.0,
    fliplr=0.5,
    mosaic=0.8,
    close_mosaic=15,
    mixup=0.0,
    copy_paste=0.0,
    # --- loss ---
    box=8.0,          # up from 7.5: box regression on a tiny object is the hard part
    cls=0.4,          # down from 0.5: one class, nothing to disambiguate
    dfl=1.6,
)


def train(data_yaml: str, out_dir: str = "runs/ball", model: str = "yolo11s.pt",
          device: str = "", resume: bool = False, **overrides) -> str:
    try:
        from ultralytics import YOLO
    except ImportError as exc:
        raise SystemExit("pip install -r ml/requirements-yolo.txt") from exc

    hyp = dict(DEFAULT_HYP)
    hyp.update({k: v for k, v in overrides.items() if v is not None})

    net = YOLO(model)
    results = net.train(
        data=data_yaml, project=out_dir, name="train", exist_ok=True,
        device=device or None, resume=resume, plots=True, val=True,
        **hyp,
    )
    best = os.path.join(str(results.save_dir), "weights", "best.pt")
    print(f"\nbest weights: {best}")
    print("point the pipeline at it with:  --weights", best)
    return best


def validate(weights: str, data_yaml: str, imgsz: int = 960, device: str = "") -> None:
    from ultralytics import YOLO

    metrics = YOLO(weights).val(data=data_yaml, imgsz=imgsz, device=device or None)
    print(metrics)
    print(
        "\nWhat to look at: mAP50 above ~0.85 and recall above ~0.90 on a held-out\n"
        "match is where rally segmentation stops being the bottleneck. If recall is\n"
        "low but precision is high, the ball is too small -- raise imgsz or enable\n"
        "tiled inference (ball.tiled=true, which is the default)."
    )


def export(weights: str, format: str = "onnx", imgsz: int = 960, half: bool = False) -> None:
    from ultralytics import YOLO

    path = YOLO(weights).export(format=format, imgsz=imgsz, half=half, simplify=True)
    print(f"exported: {path}")


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser("rally_seg.train.train_ball_yolo")
    sub = p.add_subparsers(dest="cmd", required=True)

    t = sub.add_parser("train", help="fine-tune a detector on a Roboflow YOLO export")
    t.add_argument("--data", required=True, help="path to data.yaml")
    t.add_argument("--model", default="yolo11s.pt")
    t.add_argument("--out-dir", default="runs/ball")
    t.add_argument("--epochs", type=int)
    t.add_argument("--imgsz", type=int)
    t.add_argument("--batch", type=int)
    t.add_argument("--device", default="")
    t.add_argument("--resume", action="store_true")

    v = sub.add_parser("val", help="validate weights")
    v.add_argument("--weights", required=True)
    v.add_argument("--data", required=True)
    v.add_argument("--imgsz", type=int, default=960)
    v.add_argument("--device", default="")

    e = sub.add_parser("export", help="export to onnx/coreml/etc")
    e.add_argument("--weights", required=True)
    e.add_argument("--format", default="onnx")
    e.add_argument("--imgsz", type=int, default=960)
    e.add_argument("--half", action="store_true")

    args = p.parse_args(argv)
    if args.cmd == "train":
        train(args.data, args.out_dir, args.model, args.device, args.resume,
              epochs=args.epochs, imgsz=args.imgsz, batch=args.batch)
    elif args.cmd == "val":
        validate(args.weights, args.data, args.imgsz, args.device)
    else:
        export(args.weights, args.format, args.imgsz, args.half)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
