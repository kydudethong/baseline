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
import os
import json
import time
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
    # BATCHED, because this was one model call per image over every sampled
    # frame of the clip -- 4,121 of them on a 14-minute video -- and it was by
    # far the longest stage in the pipeline. detect_players.py right next door
    # already batches; pose simply never did. One call over N frames amortises
    # the per-call Python, preprocessing and postprocessing cost that dominates
    # at this model size, exactly as it did for the ball detector.
    parser.add_argument("--batch", type=int, default=int(os.environ.get("POSE_BATCH", "16")))
    # Pinned rather than left to ultralytics' default, so the cost per frame
    # does not silently depend on the source resolution: a 1080p frame and a
    # 720p frame should cost the same here.
    parser.add_argument("--imgsz", type=int, default=int(os.environ.get("POSE_IMGSZ", "640")))
    args = parser.parse_args()

    if not args.model:
        print(json.dumps({"error": "no --model weights path given"}), file=sys.stderr)
        sys.exit(1)

    # STDOUT IS THE DATA CHANNEL, so nothing else may write to it.
    #
    # ultralytics sends some of its warnings to stdout rather than stderr
    # ("WARNING (warning sign) ..."), and one of those landing between two JSON
    # lines made the caller's JSON.parse throw and threw away the ENTIRE clip's
    # pose data -- every frame of which was sitting in that same stream,
    # perfectly good. The analysis then finished with no skeletons and no
    # explanation.
    #
    # Rebinding sys.stdout to stderr before ultralytics is even imported means
    # any library that prints casually is harmlessly diverted, while the JSON
    # below goes to the real handle kept here. Cheaper and more complete than
    # trying to silence each warning as it is discovered.
    real_stdout = sys.stdout
    sys.stdout = sys.stderr

    from ultralytics import YOLO  # imported lazily so --help doesn't need torch loaded

    model = YOLO(args.model)

    paths = args.image_paths
    done = 0
    t0 = time.time()
    print(f"[pose] {len(paths)} frames at imgsz {args.imgsz}, batch {args.batch}",
          file=sys.stderr, flush=True)

    for start in range(0, len(paths), args.batch):
        chunk = paths[start : start + args.batch]
        try:
            batch_results = model(chunk, verbose=False, conf=args.conf, imgsz=args.imgsz)
        except Exception as exc:  # noqa: BLE001 — surface as data, not a crash
            # One bad batch must not lose the rest of the clip. Every frame in
            # it is reported as its own failure, so the shape of the output is
            # identical to the unbatched version and no caller has a new case.
            for image_path in chunk:
                print(json.dumps({"imagePath": image_path, "error": str(exc), "people": []}),
                      file=real_stdout, flush=True)
            done += len(chunk)
            continue

        for image_path, r in zip(chunk, batch_results):
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
                        nx = px / w if w else None
                        ny = py / h if h else None
                        # A KEYPOINT OUTSIDE THE FRAME WAS NOT SEEN IN THE FRAME.
                        #
                        # YOLO's pose head regresses coordinates and does not
                        # clamp them, so a joint it is unsure about can land
                        # outside the image -- often at or near the origin,
                        # which is its way of saying "not here". The confidence
                        # for those is not always low enough to filter, so what
                        # reached the overlay was a limb drawn from a real
                        # shoulder to the top-left corner of the picture: the
                        # stretched grey lines shooting off every head.
                        #
                        # Reported as null, the same shape as any other joint
                        # the model did not see, so every consumer already
                        # handles it. A small margin allows the genuine case of
                        # a joint right at the edge.
                        if nx is None or ny is None or not (-0.02 <= nx <= 1.02 and -0.02 <= ny <= 1.02):
                            nx, ny, kconf = None, None, 0.0
                        keypoints.append({
                            "name": name,
                            "xNorm": nx,
                            "yNorm": ny,
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

            print(json.dumps({"imagePath": image_path, "people": people}),
                  file=real_stdout, flush=True)

        done += len(chunk)
        if done % 200 < args.batch or done == len(paths):
            rate = done / max(1e-6, time.time() - t0)
            print(f"[pose] {done}/{len(paths)} frames · {rate:.1f} fps · "
                  f"~{(len(paths) - done) / max(rate, 1e-6) / 60:.1f} min left",
                  file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
