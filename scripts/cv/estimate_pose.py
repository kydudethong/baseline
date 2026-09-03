#!/usr/bin/env python3
"""
Real pose estimation via a pretrained YOLOv8n-pose model (Ultralytics,
COCO 17-keypoint format), run locally/CPU. No training, no fabricated
keypoints — every point returned came out of the model on the actual pixels
given to it, with the model's own per-keypoint confidence passed through
unmodified.

Vendor note: Roboflow (this project's other CV vendor, used for player
detection) has no ready pretrained hosted human-pose model — only
custom-trainable keypoint projects, which would mean collecting and
labeling our own dataset before Phase 2 could ship anything. YOLOv8n-pose
is a well-validated, freely available, CPU-capable alternative, so pose
estimation runs locally instead of through Roboflow's hosted API. This is
documented as a deliberate vendor split, not an oversight.

Usage: estimate_pose.py <image_path> [<image_path> ...] [--model <path>]
Prints one JSON object per line to stdout (JSONL), one per input image:
{
  "imagePath": "...",
  "people": [
    {
      "boxImageNorm": {"x":0-1,"y":0-1,"width":0-1,"height":0-1},
      "detectionConfidence": 0-1,
      "keypoints": [{"name": "nose", "xNorm":0-1, "yNorm":0-1, "confidence":0-1}, ...]
    }
  ]
}
"""
import sys
import json
import argparse

# COCO 17-keypoint order, as produced by YOLOv8-pose.
COCO_KEYPOINT_NAMES = [
    "nose", "left_eye", "right_eye", "left_ear", "right_ear",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle",
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image_paths", nargs="+")
    parser.add_argument("--model", default=None, help="Path to a yolov8*-pose.pt weights file")
    parser.add_argument("--conf", type=float, default=0.25)
    args = parser.parse_args()

    if not args.model:
        print(json.dumps({"error": "no --model weights path given"}), file=sys.stderr)
        sys.exit(1)

    from ultralytics import YOLO  # imported lazily so --help doesn't need torch loaded

    model = YOLO(args.model)

    for image_path in args.image_paths:
        try:
            results = model(image_path, verbose=False, conf=args.conf)
        except Exception as exc:  # noqa: BLE001 — surface as data, not a crash
            print(json.dumps({"imagePath": image_path, "error": str(exc), "people": []}))
            continue

        r = results[0]
        h, w = r.orig_shape
        people = []

        boxes = r.boxes
        kpts = r.keypoints

        n = 0 if boxes is None else len(boxes)
        for i in range(n):
            cls = int(boxes.cls[i]) if boxes.cls is not None else None
            if cls != 0:  # class 0 = person in COCO
                continue
            conf = float(boxes.conf[i]) if boxes.conf is not None else None
            xywhn = boxes.xywhn[i].tolist()  # [x_center, y_center, w, h], normalized

            keypoints = []
            if kpts is not None and kpts.xy is not None:
                xy = kpts.xy[i]  # (17, 2) pixel coords
                conf_arr = kpts.conf[i] if kpts.conf is not None else None
                for k, name in enumerate(COCO_KEYPOINT_NAMES):
                    if k >= xy.shape[0]:
                        break
                    px, py = float(xy[k][0]), float(xy[k][1])
                    kconf = float(conf_arr[k]) if conf_arr is not None else None
                    keypoints.append({
                        "name": name,
                        "xNorm": px / w if w else None,
                        "yNorm": py / h if h else None,
                        "confidence": kconf,
                    })

            people.append({
                "boxImageNorm": {
                    "x": xywhn[0] - xywhn[2] / 2,
                    "y": xywhn[1] - xywhn[3] / 2,
                    "width": xywhn[2],
                    "height": xywhn[3],
                },
                "detectionConfidence": conf,
                "keypoints": keypoints,
            })

        print(json.dumps({"imagePath": image_path, "people": people}))
        sys.stdout.flush()


if __name__ == "__main__":
    main()
