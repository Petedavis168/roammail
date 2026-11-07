#!/usr/bin/env bash
# Start the local test stack: fake mailcow API, fake Stripe, Radicale (CalDAV/CardDAV) and the app.
# Each run uses a new data folder, so nothing is ever deleted. GreenMail must already be running in Docker.
#   dev/start-stack.sh [radicale-config]
set -u
cd "$(dirname "$0")/.."
pkill -f dev/mock-mailcow.js || true
pkill -f dev/mock-stripe.js || true
pkill -f src/index.js || true
sleep 0.5
if [ -n "${1:-}" ] && ! pgrep -f radicale >/dev/null; then
  python3 -m radicale --config "$1" >/dev/null 2>&1 &
fi
DATA="${TMPDIR:-/tmp}/mc-data-$(date +%s)"
node dev/mock-mailcow.js > "${TMPDIR:-/tmp}/mock.log" 2>&1 &
node dev/mock-stripe.js > "${TMPDIR:-/tmp}/stripe.log" 2>&1 &
DATA_DIR="$DATA" node --env-file=dev/test.env --disable-warning=ExperimentalWarning src/index.js > "${TMPDIR:-/tmp}/app.log" 2>&1 &
for _ in $(seq 1 30); do curl -sf localhost:3000/healthz >/dev/null && break; sleep 0.5; done
echo "stack up; data in $DATA"
grep WARNING "${TMPDIR:-/tmp}/app.log" || true
