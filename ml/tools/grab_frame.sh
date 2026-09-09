#!/usr/bin/env bash
# Pull one clean frame for court calibration.
#   ./tools/grab_frame.sh match.mp4 [seconds] [out.png]
set -euo pipefail
ffmpeg -v error -ss "${2:-5}" -i "$1" -frames:v 1 -q:v 2 "${3:-frame.png}" -y
echo "wrote ${3:-frame.png} — open ml/tools/calibrate_court.html and load it"
