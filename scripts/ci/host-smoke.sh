#!/usr/bin/env bash
set -euo pipefail
native_image="${1:?supply host-runtime image}"
baseline_image="${2:?supply release image}"
token="along-host-$RANDOM-$$"
net=$token
pg=$token-pg
native=$token-native
baseline=$token-ts
cleanup() {
  local result=$?
  if ((result != 0)); then
    docker logs "$native" >&2 || true
    docker logs "$baseline" >&2 || true
  fi
  docker rm -fv "$native" "$baseline" "$pg" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
}
trap cleanup EXIT
network_options=()
if [[ -n "${ALONG_HOST_SMOKE_SUBNET:-}" ]]; then
  network_options+=(--subnet "$ALONG_HOST_SMOKE_SUBNET")
fi
docker network create "${network_options[@]}" "$net" >/dev/null
docker run -d --name "$pg" --network "$net" -e POSTGRES_USER=along \
  -e POSTGRES_PASSWORD=along -e POSTGRES_DB=along postgres:16-alpine >/dev/null
for ((i=0; ; i++)); do
  if docker exec "$pg" pg_isready -h 127.0.0.1 -U along -d along >/dev/null 2>&1; then break; fi
  if ((i == 30)); then exit 1; fi
  sleep 1
done
for role in native baseline; do
  if [[ "$role" == native ]]; then image=$native_image; else image=$baseline_image; fi
  docker run -d --name "${!role}" --network "$net" -e ROLE=api -e TZDB_VERSION=fixture-v1 \
    -e "DATABASE_URL=postgresql://along:along@$pg/along" \
    -e BETTER_AUTH_SECRET=isolated-test-only-host-probe "$image" >/dev/null
done
MSYS_NO_PATHCONV=1 docker exec "$native" bun scripts/ci/host-smoke.mjs \
  http://127.0.0.1:3000 "http://$baseline:3000"
docker stop -t 5 "$pg" >/dev/null
MSYS_NO_PATHCONV=1 docker exec "$native" bun -e '
  const response = await fetch("http://127.0.0.1:3000/readyz", { signal: AbortSignal.timeout(5000) });
  if (response.status !== 503 || (await response.json()).reason !== "NOT_READY") process.exit(1);
'
docker stop -t 5 "$native" >/dev/null
test "$(docker inspect "$native" --format '{{.State.ExitCode}}')" = 0
printf '%s\n' 'Dependency failure and SIGTERM passed.'
