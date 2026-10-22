#!/usr/bin/env bash
# Runs the acceptance tests against a Node module implementation on a private local board.
#   test/run.sh [pluginDir] [port]
# pluginDir defaults to board/plugins/farzad. The stand-in gateway from test/fake-gateway is mounted as /t/pisak/;
# set GATEWAY_DIR=board/plugins/pisak to test against the real gateway plugin instead.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PLUGIN="$(cd "${1:-$ROOT/board/plugins/farzad}" && pwd)"
PORT="${2:-8191}"
TMP="$(mktemp -d)"
mkdir -p "$TMP/plugins" "$TMP/data" "$TMP/colony"
ln -s "$PLUGIN" "$TMP/plugins/farzad"
ln -s "$(cd "${GATEWAY_DIR:-$HERE/fake-gateway}" && pwd)" "$TMP/plugins/pisak"

PORT="$PORT" DATA_DIR="$TMP/data" PLUGINS_DIR="$TMP/plugins" COLONY_DIR="$TMP/colony" \
  node "$ROOT/board/server.js" > "$TMP/server.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "$TMP"' EXIT

for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 0.2; done
node "$HERE/acceptance.mjs" "http://127.0.0.1:$PORT"
RC=$?
if grep -qiE "error|exception" "$TMP/server.log"; then echo "--- server log (errors) ---"; grep -iE "error|exception" "$TMP/server.log" | head -20; fi
exit $RC
