#!/usr/bin/env bash
#
# One command to ship Baseline.
#
# This exists because the deploy needs three build args whose values live in
# .env.local, and typing them by hand is both tedious and the kind of thing
# that fails silently: an unset NEXT_PUBLIC_* is baked into the browser bundle
# as the string "undefined", the server keeps working, and the client half of
# the app breaks with nothing in the logs to say why. A script cannot forget.
#
#   npm run deploy          deploy
#   npm run deploy -- -n    dry run: print the command, change nothing
#
set -euo pipefail

cd "$(dirname "$0")/.."

DRY=0
[[ "${1:-}" == "-n" || "${1:-}" == "--dry-run" ]] && DRY=1

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }

[[ -f .env.local ]] || { red "No .env.local here. Run this from the repo, not a copy."; exit 1; }
command -v fly >/dev/null || { red "flyctl not on PATH. https://fly.io/docs/flyctl/install/"; exit 1; }

# Read .env.local without exporting it into anything else's environment. `set
# -a` marks assignments for export, which is what makes the values reach the
# fly subprocess; it is turned straight back off.
set -a
# shellcheck disable=SC1091
source .env.local
set +a

# The three the image needs at BUILD time. Everything else the app reads at
# runtime and comes from `fly secrets`, which is why only these three are here.
REQUIRED=(NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY)
missing=()
for v in "${REQUIRED[@]}"; do [[ -n "${!v:-}" ]] || missing+=("$v"); done
if (( ${#missing[@]} )); then
  red "Missing from .env.local: ${missing[*]}"
  red "These are inlined into the browser bundle at build time. Deploying"
  red "without them produces a site whose client half silently does nothing."
  exit 1
fi

APP=$(awk -F"'" '/^app *=/ {print $2}' fly.toml)
APP=${APP:-baseline-court}
SITE_URL=${DEPLOY_SITE_URL:-https://${APP}.fly.dev}

# The laptop-only settings. A Fly secret OVERRIDES the Dockerfile's ENV, so if
# one of these is still set from `fly secrets import < .env.local` it silently
# beats the correct container value — CV_PYTHON in particular points at a macOS
# path that does not exist in the image, which fails every analysis.
LAPTOP_ONLY=(CV_PYTHON RALLY_SEG_DIR RALLY_SEG_DEBUG)
if secrets=$(fly secrets list --app "$APP" 2>/dev/null); then
  stale=()
  for v in "${LAPTOP_ONLY[@]}"; do grep -qE "^${v}[[:space:]]" <<<"$secrets" && stale+=("$v"); done
  if (( ${#stale[@]} )); then
    ylw "These secrets are set on the server and must not be:"
    ylw "  ${stale[*]}"
    ylw "Fix with:  fly secrets unset ${stale[*]}"
    (( DRY )) || { red "Refusing to deploy. Unset them first."; exit 1; }
  fi
fi

ylw "Reminder: a deploy replaces the machine, which ends any analysis that is"
ylw "mid-run — the pipeline lives in one process's memory. Runs killed this way"
ylw "sit at 'processing' until the 30-minute stale window lets them restart."
echo

cmd=(fly deploy --app "$APP"
     --build-arg "NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL"
     --build-arg "NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY"
     --build-arg "NEXT_PUBLIC_SITE_URL=$SITE_URL")

if (( DRY )); then
  # Values are redacted here rather than printed. The anon key is public by
  # design, but a dry run is the thing people paste into chat threads.
  printf 'would run:\n  fly deploy --app %s \\\n' "$APP"
  printf '    --build-arg NEXT_PUBLIC_SUPABASE_URL=%s \\\n' "$NEXT_PUBLIC_SUPABASE_URL"
  printf '    --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<%s chars from .env.local> \\\n' "${#NEXT_PUBLIC_SUPABASE_ANON_KEY}"
  printf '    --build-arg NEXT_PUBLIC_SITE_URL=%s\n' "$SITE_URL"
  exit 0
fi

"${cmd[@]}"

echo
grn "Deployed. Checking it answers…"
# `|| echo 000` would CONCATENATE with the 000 curl already printed on a
# connection failure, giving "000000". Swallow curl's exit status instead
# and let the empty case fall through to the default.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$SITE_URL" 2>/dev/null || true)
code=${code:-000}
if [[ "$code" == "200" ]]; then
  grn "$SITE_URL -> 200"
else
  red "$SITE_URL -> $code"
  red "Machine can be 'started' and still not serve: check HOSTNAME=0.0.0.0 is"
  red "in the image, then run  fly logs --app $APP"
  exit 1
fi
