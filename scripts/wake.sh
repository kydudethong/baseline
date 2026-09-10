#!/usr/bin/env bash
#
# Start the Fly machine and wait until it actually serves.
#
# Not strictly necessary -- auto_start_machines wakes it on the first request
# -- but that first visitor pays a cold start measured in tens of seconds on
# an image this size. Run this a minute before showing anyone.
#
set -euo pipefail
cd "$(dirname "$0")/.."

red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }

command -v fly >/dev/null || { red "flyctl not on PATH. https://fly.io/docs/flyctl/install/"; exit 1; }
APP=$(awk -F"'" '/^app *=/ {print $2}' fly.toml)
APP=${APP:-baseline-court}
SITE_URL=${DEPLOY_SITE_URL:-https://${APP}.fly.dev}

ids=$(fly machines list --app "$APP" --json | python3 -c '
import json,sys
for m in json.load(sys.stdin):
    if m.get("state") != "started":
        print(m["id"])
')
for id in $ids; do
  echo "starting $id…"
  fly machine start "$id" --app "$APP"
done

echo "waiting for $SITE_URL to answer…"
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$SITE_URL" 2>/dev/null || true)
  if [[ "${code:-000}" == "200" ]]; then grn "$SITE_URL -> 200. Awake."; exit 0; fi
  sleep 5
done
red "Still not answering after 2.5 minutes. Check: fly logs --app $APP"
exit 1
