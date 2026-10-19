#!/usr/bin/env sh
# compose smoke (D7): fresh volume — /healthz 200, /me + /brief 401,
# /readyz 503+TZDB_UNAVAILABLE without TZDB, 200 with TZDB.
set -eu

COMPOSE="docker compose -f infra/compose/compose.yaml"
BASE="http://localhost:3000"

fail() {
  echo "smoke FAIL: $1" >&2
  exit 1
}

check() {
  path="$1"
  want="$2"
  code=$(curl -s -o /tmp/along-body.json -w "%{http_code}" "$BASE$path")
  [ "$code" = "$want" ] || fail "$path -> $code (want $want); body: $(cat /tmp/along-body.json)"
  echo "ok $path -> $code"
}

echo "== boot without TZDB_VERSION =="
$COMPOSE down -v >/dev/null 2>&1 || true
$COMPOSE up -d --build
trap '$COMPOSE down -v >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 30); do
  curl -sf "$BASE/healthz" >/dev/null 2>&1 && break
  sleep 2
done

check "/healthz" 200
check "/api/v1/me" 401
check "/api/v1/brief" 401

code=$(curl -s -o /tmp/along-body.json -w "%{http_code}" "$BASE/readyz")
[ "$code" = "503" ] || fail "/readyz (no TZDB) -> $code (want 503)"
grep -q "TZDB_UNAVAILABLE" /tmp/along-body.json || fail "/readyz body missing TZDB_UNAVAILABLE"
echo "ok /readyz (no TZDB) -> 503 TZDB_UNAVAILABLE"

echo "== reboot with TZDB_VERSION =="
$COMPOSE down -v >/dev/null 2>&1 || true
TZDB_VERSION=2024a $COMPOSE up -d --build

for _ in $(seq 1 30); do
  curl -sf "$BASE/healthz" >/dev/null 2>&1 && break
  sleep 2
done

check "/readyz" 200
echo "smoke PASS"
