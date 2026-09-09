# Weights

Nothing here is checked in — these files are large and are built, not authored.

| file | what | how to get it |
|---|---|---|
| `ball_yolo.pt` | pickleball detector, one class | `python -m rally_seg.train.train_ball_yolo train --data <roboflow>/data.yaml` then copy `runs/ball/train/weights/best.pt` here |
| `yolov8n.pt` | COCO person detector | downloaded automatically by ultralytics on first use |
| `temporal_tcn.pt` | learned rally segmenter | `python -m rally_seg.train.export_dataset` then `python -m rally_seg.train.train_temporal` |
| `court_kp.pt` | optional court keypoint model | only if the classical fit struggles on your camera angle |

Sanity check before trusting a ball detector on a match:

```bash
python -m rally_seg.train.train_ball_yolo val --weights models/ball_yolo.pt --data <roboflow>/data.yaml
```

mAP50 around 0.85 and recall around 0.90 on a *held-out match* — not a held-out
random frame split, which leaks — is where rally segmentation stops being
limited by detection.
