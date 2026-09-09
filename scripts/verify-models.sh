#!/usr/bin/env bash
#
# Check the configured ball and paddle models actually load and detect, before
# they are trusted with a real run or pushed to the server.
#
# The failure this exists to prevent: a model id that is wrong -- a workspace
# prefix, a version that was never trained, an Instant model that cannot load
# locally -- fails several minutes into an analysis, inside a stage whose error
# is reported as "ball detection failed". That reads as a broken pipeline
# rather than a typo in one environment variable. Ten seconds of footage is
# enough to tell the difference, so spend that first.
set -uo pipefail
cd "$(dirname "$0")/.."

CLIP="${1:-$HOME/Downloads/ky-720p.mp4}"
SECS="${2:-10}"

# shellcheck disable=SC1091
set -a; source .env.local; set +a
PY="${CV_PYTHON:-python3}"

grn() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }
ylw() { printf '\033[33m%s\033[0m\n' "$*"; }

[[ -f "$CLIP" ]] || { red "no clip at $CLIP"; exit 1; }
echo "clip:   $CLIP  (first ${SECS}s)"
echo "python: $PY"
echo "ball:   ${BALL_MODEL_ID:-<unset>}"
echo

fail=0

check() {              # check <label> <script> <env-var-name> <out>
  local label="$1" script="$2" varname="$3" out="$4"
  local model="${!varname:-}"
  if [[ -z "$model" ]]; then ylw "$label: $varname is not set, skipping"; return; fi
  echo "--- $label ($model)"
  if ! "$PY" "$script" "$CLIP" --windows "[[0,$SECS]]" --out "$out" 2>/tmp/pb-verify.err; then
    red "$label: FAILED to run"
    # The last few lines are the actual exception; the rest is inference's
    # startup chatter about optional extras it does not need.
    tail -6 /tmp/pb-verify.err | sed 's/^/    /'
    fail=1
    return
  fi
  "$PY" - "$out" "$label" <<'PYEOF'
import json, sys
res = json.load(open(sys.argv[1]))
label = sys.argv[2]
dets = res.get("detections", [])
proc = res.get("framesProcessed") or (res.get("diagnostics") or {}).get("framesProcessed") or 0
frames = len({d["frame"] for d in dets if "frame" in d})
pct = 100 * frames / proc if proc else 0
print(f"    {proc} frames looked at, {frames} with a detection ({pct:.0f}%), {len(dets)} boxes")
if frames == 0:
    print(f"    \033[31m{label}: the model LOADED but found nothing. Wrong model, or wrong class names.\033[0m")
    sys.exit(3)
print(f"    \033[32m{label}: OK\033[0m")
PYEOF
  [[ $? -eq 0 ]] || fail=1
}

check "ball"   scripts/cv/detect_ball.py    BALL_MODEL_ID   /tmp/pb-ball.json
# No paddle check: paddle detection was removed. Position comes from the
# swinging arm now (src/lib/vision/paddle-from-pose.ts), which needs no model
# and so has nothing to verify here.

echo
if [[ $fail -eq 0 ]]; then
  grn "Both models load and detect. Safe to run a real analysis."
  echo "Next: compare against the old ball model —"
  echo "  \$CV_PYTHON ml-experiments/ball_detectors_compare.py \\"
  echo "      $CLIP --seconds 20 --detectors roboflow,roboflow:pickleball-vision/6"
else
  red "Something did not work. Do NOT push these to the server yet."
  echo "If a model loaded but found nothing, it may be Instant-only (needs --hosted)"
  echo "or its class names may not match what detect_ball.py looks for."
  exit 1
fi
