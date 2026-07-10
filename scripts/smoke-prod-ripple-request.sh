#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${RIPPLE_BASE_URL:-http://43.98.170.138:8810}"
USER_ID="${RIPPLE_USER_ID:-smoke-user}"
MODEL="${RIPPLE_MODEL:-codex-low}"
TIMEOUT="${RIPPLE_TIMEOUT_SECONDS:-240}"
RUN_CHAT="${RIPPLE_SMOKE_CHAT:-0}"

extract_api_key() {
  local config="${RIPPLE_CONFIG:-$ROOT/config/settings.yaml}"
  if [[ -n "${RIPPLE_API_KEY:-}" ]]; then
    printf '%s' "$RIPPLE_API_KEY"
    return 0
  fi
  if [[ ! -r "$config" ]]; then
    return 0
  fi
  awk '
    /^[[:space:]]*api_keys:[[:space:]]*$/ { in_keys=1; next }
    in_keys && /^[^[:space:]]/ { exit }
    in_keys && /^[[:space:]]*-[[:space:]]*/ {
      line=$0
      sub(/^[[:space:]]*-[[:space:]]*/, "", line)
      gsub(/^"|"$/, "", line)
      print line
      exit
    }
  ' "$config"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required" >&2
    exit 1
  fi
}

curl_json() {
  curl -fsS -m "$TIMEOUT" "$@"
}

require_cmd curl

API_KEY="$(extract_api_key)"
AUTH_HEADERS=()
if [[ -n "$API_KEY" ]]; then
  AUTH_HEADERS=(-H "Authorization: Bearer $API_KEY" -H "X-Ripple-User-Id: $USER_ID")
fi

echo "==> GET $BASE_URL/health"
HEALTH="$(curl_json "$BASE_URL/health")"
echo "$HEALTH"
grep -q '"status":"ok"' <<<"$HEALTH"

if [[ -z "$API_KEY" ]]; then
  echo "==> RIPPLE_API_KEY not set and no readable config key found; skipped authenticated checks."
  echo "Smoke check passed: public health endpoint is reachable."
  exit 0
fi

echo "==> GET $BASE_URL/v1/health/ready"
READY="$(curl_json "${AUTH_HEADERS[@]}" "$BASE_URL/v1/health/ready")"
echo "$READY"
grep -q '"status":"ready"' <<<"$READY"

echo "==> GET $BASE_URL/v1/models"
MODELS="$(curl_json "${AUTH_HEADERS[@]}" "$BASE_URL/v1/models")"
echo "$MODELS" | grep -o '"id":"[^"]*"' | head -n 5 || true
grep -q '"object":"list"' <<<"$MODELS"

if [[ "$RUN_CHAT" == "1" ]]; then
  REQ_ID="smoke-$(date +%s)"
  PAYLOAD='{"model":"'"$MODEL"'","stream":false,"metadata":{"req_id":"'"$REQ_ID"'"},"input":"Return exactly OK."}'

  echo "==> POST $BASE_URL/v1/responses"
  RESPONSE="$(curl_json \
    "${AUTH_HEADERS[@]}" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "$BASE_URL/v1/responses")"
  echo "$RESPONSE"
  grep -q '"status":"completed"' <<<"$RESPONSE"
  grep -q '"output_text":"OK"' <<<"$RESPONSE"
fi

echo "Smoke check passed: $BASE_URL"
