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
docker exec "$native" bash -ec '
  tls=$(mktemp -d)
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
    -addext "subjectAltName=DNS:localhost" -keyout "$tls/key.pem" -out "$tls/cert.pem" >/dev/null 2>&1
  ALONG_HOST_TLS_CERT="$tls/cert.pem" ALONG_HOST_TLS_KEY="$tls/key.pem" /app/host/bin/along-host 3001 &
  pid=$!
  trap "rm -rf \"$tls\"" EXIT
  for ((i=0; i<25; i++)); do
    if (echo >/dev/tcp/127.0.0.1/3001) 2>/dev/null; then break; fi
    sleep .2
  done
  result=0
  NODE_EXTRA_CA_CERTS="$tls/cert.pem" bun scripts/ci/host-smoke.mjs \
    https://localhost:3001 "$1" || result=$?
  kill -TERM "$pid"
  wait "$pid"
  exit "$result"
' _ "http://$baseline:3000"
docker exec "$native" bun scripts/ci/host-worker-smoke.ts
docker exec "$native" bun scripts/ci/host-chat-smoke.ts
docker exec "$native" bun scripts/ci/host-run-smoke.ts
docker stop -t 5 "$pg" >/dev/null
MSYS_NO_PATHCONV=1 docker exec "$native" bun -e '
  const response = await fetch("http://127.0.0.1:3000/readyz", { signal: AbortSignal.timeout(5000) });
  if (response.status !== 503 || (await response.json()).reason !== "NOT_READY") process.exit(1);
'
docker exec "$native" bun -e '
  const { readdirSync, readFileSync } = await import("node:fs");
  const childCommand = "/app/apps/api/dist/bin/host-readiness.js";
  const pid = readdirSync("/proc").find((entry) => {
    if (!/^\d+$/.test(entry)) return false;
    try {
      return readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0")[1] === childCommand;
    } catch {
      return false;
    }
  });
  if (!pid) throw Error("capability process missing");
  process.kill(Number(pid), "SIGSTOP");
  try {
    const stream = await fetch("http://127.0.0.1:3000/readyz/events", {
      signal: AbortSignal.timeout(1800)
    });
    const reader = stream.body.getReader();
    const { value } = await reader.read();
    if (new TextDecoder().decode(value) !== ": readiness\n\n") throw Error("missing SSE heartbeat");
    await reader.cancel();
    const health = await fetch("http://127.0.0.1:3000/healthz", {
      signal: AbortSignal.timeout(1800)
    });
    if (!health.ok) throw Error("host did not serve health after SSE disconnect");
  } catch (error) {
    process.kill(Number(pid), "SIGCONT");
    throw error;
  }
  try {
    const started = performance.now();
    const response = await fetch("http://127.0.0.1:3000/readyz", { signal: AbortSignal.timeout(5000) });
    const elapsed = performance.now() - started;
    if (response.status !== 503 || elapsed < 2000 || (await response.json()).reason !== "NOT_READY") {
      throw Error(`unexpected readiness timeout: ${response.status} in ${elapsed} ms`);
    }
  } finally {
    process.kill(Number(pid), "SIGCONT");
  }
'
docker stop -t 5 "$native" >/dev/null
test "$(docker inspect "$native" --format '{{.State.ExitCode}}')" = 0
printf '%s\n' 'Dependency failure, capability timeout and SIGTERM passed.'
