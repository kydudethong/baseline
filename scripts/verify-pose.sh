#!/usr/bin/env bash
#
# Does pose estimation actually work in THIS environment?
#
# The failure this exists for: an analysis finished, the overlay rendered, the
# boxes were right, and "Pose rows" was 0. Nothing crashed and nothing in the
# UI said why. Pose is the one CV stage that can return an empty result through
# a completely successful-looking run -- estimate_pose.py reports a bad batch as
# DATA (one {"error": ...} per frame) rather than a non-zero exit, so a missing
# weights file or a broken torch install looks exactly like "the model saw
# nobody".
#
# Ten seconds of footage separates those two. Spend it before deploying.
set -uo pipefail
cd "$(dirname "$0")/.."

CLIP="${1:-$HOME/Downloads/ky-720p.mp4}"
FRAMES="${2:-12}"

set -a; [[ -f .env.local ]] && source .env.local; set +a
PY="${CV_PYTHON:-python3}"
MODEL="$(pwd)/models/yolov8n-pose.pt"

grn() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }

[[ -f "$CLIP" ]] || { red "no clip at $CLIP"; exit 1; }
echo "clip:   $CLIP"
echo "python: $PY"
echo "model:  $MODEL"

# The weights, checked FIRST and by hand. Without this line a missing file is
# not an error: ultralytics treats an unknown path as a model NAME and goes to
# GitHub for it, which succeeds on a laptop and fails on a box with no egress
# -- and fails differently again on one where the download half-completes.
if [[ ! -f "$MODEL" ]]; then
  red "MISSING: $MODEL"
  echo "  Every pose call will try to download this instead, and on the server that fails silently."
  exit 1
fi
echo "        $(wc -c < "$MODEL" | tr -d ' ') bytes"
echo

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ffmpeg -loglevel error -y -i "$CLIP" -vf "fps=2" -frames:v "$FRAMES" "$TMP/f_%03d.jpg" || {
  red "ffmpeg could not extract frames"; exit 1; }
COUNT=$(ls "$TMP"/*.jpg 2>/dev/null | wc -l | tr -d ' ')
echo "extracted $COUNT frames"
echo

"$PY" scripts/cv/estimate_pose.py "$TMP"/*.jpg --model "$MODEL" > "$TMP/out.jsonl" 2>"$TMP/err.txt"
STATUS=$?

if [[ $STATUS -ne 0 ]]; then
  red "estimate_pose.py exited $STATUS"
  tail -12 "$TMP/err.txt" | sed 's/^/    /'
  exit 1
fi

"$PY" - "$TMP/out.jsonl" <<'PYEOF'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
errs = [r for r in rows if r.get("error")]
people = sum(len(r.get("people", [])) for r in rows)
kp = sum(
    1 for r in rows for p in r.get("people", [])
    for k in p.get("keypoints", []) if (k.get("confidence") or 0) >= 0.3
)
print(f"    {len(rows)} frames read back, {people} person detection(s), {kp} confident keypoint(s)")
if errs:
    print(f"\033[31m    {len(errs)} frame(s) the model errored on. First:\033[0m")
    print("      " + str(errs[0].get("error"))[:300])
    sys.exit(3)
if people == 0:
    print("\033[31m    The model LOADED and found nobody. That is a model or a footage problem,\033[0m")
    print("\033[31m    not a plumbing one — and it is what an empty overlay looks like.\033[0m")
    sys.exit(3)
print("\033[32m    pose: OK\033[0m")
PYEOF
RC=$?

echo
if [[ $RC -eq 0 ]]; then
  grn "Pose works here. If the server still reports 0 pose rows, the difference is the container,"
  echo "not the code — check that models/yolov8n-pose.pt made it into the image."
else
  red "Pose is broken HERE, which means it is broken on the server for the same reason."
  exit 1
fi
