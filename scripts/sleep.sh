#!/usr/bin/env bash
#
# Stop the Fly machine so it stops costing money.
#
# A running Machine is billed by the hour whether anyone visits or not; a
# stopped one is billed only for its root filesystem, at $0.15/GB/month. For a
# project being tested a few hours a week that is the difference between ~$62
# a month and small change.
#
# The site does NOT go away. fly.toml has auto_start_machines = true, so the
# next HTTP request wakes the machine automatically. The visible cost is a
# cold start on that first request -- this image carries torch and ffmpeg, so
# expect tens of seconds, not the instant response of a warm machine.
#
#   npm run sleep     stop it
#   npm run wake      start it again (skip the cold start before a demo)
#
set -euo pipefail
cd "$(dirname "$0")/.."

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }

command -v fly >/dev/null || { red "flyctl not on PATH. https://fly.io/docs/flyctl/install/"; exit 1; }
APP=$(awk -F"'" '/^app *=/ {print $2}' fly.toml)
APP=${APP:-baseline-court}

# An analysis lives in the machine's memory and continues after its HTTP
# response has gone back, so stopping mid-run kills it. There is no way to ask
# from out here without database credentials, so this asks the person who
# knows.
ylw "Stopping the machine ends any analysis that is still running."
ylw "A run killed this way sits at 'processing' until the 30-minute stale"
ylw "window lets it restart."
read -r -p "Is anything processing right now? [y/N] " busy
case "${busy:-n}" in
  [yY]*) red "Leaving it running. Try again when the run has finished."; exit 1 ;;
esac

ids=$(fly machines list --app "$APP" --json | python3 -c '
import json,sys
for m in json.load(sys.stdin):
    if m.get("state") == "started":
        print(m["id"])
')

if [[ -z "$ids" ]]; then
  grn "Nothing running — already asleep."
  exit 0
fi

for id in $ids; do
  echo "stopping $id…"
  fly machine stop "$id" --app "$APP"
done

grn "Asleep. You are now paying for disk only (about \$0.15/GB/month)."
grn "The next visitor wakes it automatically, after a cold start."
