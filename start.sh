#!/usr/bin/env bash

# Serve the repository over localhost so ES modules and Web Bluetooth can run.
set -euo pipefail

readonly PORT="${PORT:-4178}"
readonly URL="http://localhost:${PORT}/"
readonly PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  printf 'python3 is required to start the local server.\n' >&2
  exit 1
fi

cd "$PROJECT_ROOT"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  printf 'Port %s is already in use. Stop the existing server or run PORT=<port> ./start.sh.\n' "$PORT" >&2
  exit 1
fi

python3 -m http.server "$PORT" --bind 127.0.0.1 &
server_pid=$!

cleanup() {
  kill "$server_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

sleep 0.3
if ! kill -0 "$server_pid" >/dev/null 2>&1; then
  printf 'The local server failed to start.\n' >&2
  exit 1
fi

if [[ -d /Applications/Google\ Chrome.app ]]; then
  open -a "Google Chrome" "$URL"
elif [[ -d /Applications/Microsoft\ Edge.app ]]; then
  open -a "Microsoft Edge" "$URL"
else
  open "$URL"
fi

printf 'ArcheryAimTrace is running at %s\nPress Ctrl-C to stop the server.\n' "$URL"
wait "$server_pid"
