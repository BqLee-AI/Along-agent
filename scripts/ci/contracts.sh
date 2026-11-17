#!/usr/bin/env bash
# Internal consumer: runtime.sh owns the current-tree image.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
image="${1:?runtime.sh must supply its current-tree image}"
owned="$(mktemp -d "${TMPDIR:-/tmp}/along-contracts.XXXXXX")"
token="$(basename "$owned")"
network="$token-net"
postgres="$token-pg"
consumer="$token-consumer"
cleanup() {
  local result=$?
  trap - EXIT
  if docker container inspect "$consumer" >/dev/null 2>&1; then
    docker rm --force --volumes "$consumer" || result=1
  fi
  if docker container inspect "$postgres" >/dev/null 2>&1; then
    docker rm --force --volumes "$postgres" || result=1
  fi
  if docker network inspect "$network" >/dev/null 2>&1; then
    docker network rm "$network" || result=1
  fi
  rmdir "$owned" || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo '== D8 private fresh PostgreSQL 16 =='
docker network create "$network"
docker run --detach --rm --name "$postgres" --network "$network" \
  --env POSTGRES_USER=along --env POSTGRES_PASSWORD=along --env POSTGRES_DB=along \
  --health-cmd 'pg_isready -h 127.0.0.1 -U along -d along' \
  --health-interval 1s --health-timeout 3s --health-retries 60 postgres:16-alpine
ready=false
for ((attempt=0; attempt<65; attempt++)); do
  health="$(docker container inspect --format '{{.State.Health.Status}}' "$postgres")"
  if [[ "$health" == healthy ]]; then ready=true; break; fi
  if [[ "$health" != starting ]]; then break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  docker logs "$postgres"
  echo 'D8: private PostgreSQL did not become ready' >&2
  exit 1
fi

echo '== D8 real native consumers and this-run report =='
# Only task-owned database/test auth enter the container; no personal model configuration.
# A new container owns this report directory; omission cannot consume an earlier run's report.
docker run --pull never --rm --name "$consumer" --network "$network" \
  --env "DATABASE_URL=postgresql://along:along@$postgres:5432/along" \
  --env BETTER_AUTH_SECRET=ci-only-secret-for-harness-contracts \
  "$image" bash -c '
    set -eu
    mkdir /tmp/d8-contracts
    mapfile -t native_tests < ci/native-tests.txt
    bun test --parallel=4 --timeout 30000 --reporter=junit \
      --reporter-outfile /tmp/d8-contracts/report.xml \
      ./apps/api/test/contracts.test.ts ./apps/api/test/contracts ./apps/harness/test/contracts \
      ./apps/api/test/integration/tool-invocations-nontransactional.test.ts \
      ./packages/contracts/test ./packages/stream-protocol/test "${native_tests[@]}"
    bun scripts/check-gates-executable.mjs . /tmp/d8-contracts/report.xml
  '
