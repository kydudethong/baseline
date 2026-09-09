#!/usr/bin/env bash
# Score a detections file against the hand-labelled rallies, and render the
# debug video. Rendering reads the cached detections rather than re-running any
# model, so it costs a video decode and nothing else.
#
#   tools/run_ky.sh                          # default: ky-native.json
#   tools/run_ky.sh <video> <detections.json>
#
# Output names are derived from the detections file, so runs with different
# models do not overwrite each other.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=.venv/bin/python
VIDEO="${1:-$HOME/Downloads/ky-720p.mp4}"
DETS="${2:-$HOME/Downloads/pb-analyzer/shot-results/ky-native.json}"
TAG="$(basename "$DETS" .json)"

COMMON=(--set ball.backend=replay
        --set "ball.replay_path=$DETS"
        --set court.manual_points_path=configs/ky_court.json)

echo "=== $TAG: scoring against hand labels ==="
$PY -m rally_seg eval "$VIDEO" --truth configs/ky_truth.json "${COMMON[@]}"

echo
echo "=== rendering the debug video ==="
$PY -m rally_seg debug "$VIDEO" "${COMMON[@]}" \
    --out "$HOME/Downloads/$TAG-debug.mp4" \
    --json "$HOME/Downloads/$TAG-rallies.json"
echo
echo "open $HOME/Downloads/$TAG-debug.mp4"
