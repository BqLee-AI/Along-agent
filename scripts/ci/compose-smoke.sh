#!/usr/bin/env bash
# D7: both fresh-volume readiness states consume the image built by runtime.sh.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
export CI_RUNTIME_IMAGE="${1:?runtime.sh must supply its current-tree image}"
COMPOSE="docker compose -f infra/compose/compose.yaml -f infra/compose/ci.yaml"
body="$(mktemp)"
cleanup() {
  local result=$?
  trap - EXIT
  $COMPOSE down -v >/dev/null 2>&1 || result=1
  rm -f "$body"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  echo "smoke FAIL: $1" >&2
  exit 1
}

check() {
  path="$1"
  want="$2"
  code=$(curl -s -o "$body" -w "%{http_code}" "$BASE$path")
  [ "$code" = "$want" ] || fail "$path -> $code (want $want); body: $(cat "$body")"
  echo "ok $path -> $code"
}

echo "== boot without TZDB_VERSION =="
$COMPOSE down -v
$COMPOSE up -d --no-build
BASE="http://$($COMPOSE port api 3000)"

for _ in $(seq 1 30); do
  curl -sf "$BASE/healthz" >/dev/null 2>&1 && break
  sleep 2
done

check "/healthz" 200
check "/api/v1/me" 401
check "/api/v1/brief" 401

code=$(curl -s -o "$body" -w "%{http_code}" "$BASE/readyz")
[ "$code" = "503" ] || fail "/readyz (no TZDB) -> $code (want 503)"
grep -q "TZDB_UNAVAILABLE" "$body" || fail "/readyz body missing TZDB_UNAVAILABLE"
echo "ok /readyz (no TZDB) -> 503 TZDB_UNAVAILABLE"

echo "== reboot with TZDB_VERSION =="
$COMPOSE down -v
TZDB_VERSION=fixture-v1 $COMPOSE up -d --no-build
BASE="http://$($COMPOSE port api 3000)"

for _ in $(seq 1 30); do
  curl -sf "$BASE/healthz" >/dev/null 2>&1 && break
  sleep 2
done

check "/readyz" 200
echo "smoke PASS"
