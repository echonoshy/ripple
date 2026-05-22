#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ripple-rust-smoke.XXXXXX")"
PORT="${RIPPLE_SMOKE_PORT:-$((43000 + $$ % 10000))}"
API_KEY="${RIPPLE_SMOKE_API_KEY:-smoke-key}"
CONFIG="$TMP_DIR/settings.yaml"
LOG="$TMP_DIR/server.log"
PID=""

cleanup() {
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for this smoke check" >&2
  exit 1
fi

cat >"$CONFIG" <<EOF
server:
  host: "127.0.0.1"
  port: $PORT
  api_keys: ["$API_KEY"]
  sandbox:
    sandboxes_root: "$TMP_DIR/sandboxes"
    caches_root: "$TMP_DIR/cache"
    idle_suspend_seconds: 1800
    retention_seconds: 3600
model:
  default: "codex-test"
  presets:
    codex-test:
      model: "codex-test"
external_agents:
  codex:
    enabled: true
    codex_executable: "codex"
    app_server_args: ["app-server", "--listen", "stdio://"]
skills:
  shared_dirs: []
EOF

cd "$ROOT"
RIPPLE_CONFIG="$CONFIG" cargo run -p ripple-server >"$LOG" 2>&1 &
PID="$!"

for _ in $(seq 1 80); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "Rust server exited before /health became ready" >&2
    cat "$LOG" >&2
    exit 1
  fi
  sleep 0.1
done

curl -fsS "http://127.0.0.1:$PORT/health" | grep -q '"ripple-rust-server"'
curl -fsS \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Ripple-User-Id: smoke-user" \
  "http://127.0.0.1:$PORT/v1/models" \
  | grep -q '"object":"list"'
curl -fsS \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Ripple-User-Id: smoke-user" \
  -H "Content-Type: application/json" \
  -d '{"model":"codex-test"}' \
  "http://127.0.0.1:$PORT/v1/sessions" \
  | grep -q '"session_id"'

echo "Rust server smoke check passed on http://127.0.0.1:$PORT"
