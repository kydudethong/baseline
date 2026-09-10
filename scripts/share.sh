#!/usr/bin/env bash
#
# Put the app on the public internet from this laptop, for free.
#
# A Cloudflare quick tunnel gives a public https URL that forwards to a port on
# this machine. No account, no card, no domain, no port forwarding. The URL is
# random and lasts until you stop the tunnel.
#
# For testing with a few people this beats the deployed site on every axis that
# matters right now: it costs nothing, and this laptop has more cores than the
# Fly machine, so analyses finish faster.
#
# What it is NOT: a way to run the product. The site exists only while this
# script does, the URL changes each time, and anyone with the link reaches a
# server on your own machine. Fine among people you know, wrong for strangers.
#
#   npm run share          production build, the honest test
#   npm run share -- dev   dev server, hot reload, slower
#
set -euo pipefail
cd "$(dirname "$0")/.."

red() { printf '\033[31m%s\033[0m\n' "$*"; }
ylw() { printf '\033[33m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }

MODE=${1:-prod}
PORT=${PORT:-3000}

if ! command -v cloudflared >/dev/null; then
  red "cloudflared is not installed. On a Mac:"
  red "  brew install cloudflared"
  exit 1
fi
[[ -f .env.local ]] || { red "No .env.local here. Run this from the repo."; exit 1; }

# NEXT_PUBLIC_SITE_URL is baked into the browser bundle at BUILD time, and the
# tunnel URL does not exist until the tunnel is up -- so a production build
# cannot know it. Anything that builds an absolute URL from it (email links,
# OAuth redirects) will point at localhost for people on the tunnel. Same-origin
# requests, which is nearly everything here, are unaffected.
ylw "Note: NEXT_PUBLIC_SITE_URL is fixed at build time, so absolute links"
ylw "(auth redirects, emails) will still point wherever it was built for."
echo

if [[ "$MODE" == "dev" ]]; then
  npm run dev -- --port "$PORT" &
else
  echo "building…"
  set -a; . ./.env.local; set +a
  npm run build
  npm run start -- --port "$PORT" &
fi
APP_PID=$!

# Kill the server whatever happens -- Ctrl-C, an error, or the tunnel dying.
# Without this the port stays occupied and the next run fails with EADDRINUSE.
cleanup() { kill "$APP_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "waiting for localhost:$PORT…"
for _ in $(seq 1 60); do
  curl -s -o /dev/null --max-time 3 "http://localhost:$PORT" && break
  sleep 2
done

grn "Starting the tunnel. The public URL appears below — share that one."
grn "Ctrl-C stops both the tunnel and the server."
echo
cloudflared tunnel --url "http://localhost:$PORT"
