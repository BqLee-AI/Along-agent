#!/usr/bin/env bash
# D8: current production build, private PG16, real native consumers, current execution report.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo 'test:contracts requires Linux x64 Docker; on Windows run the root command in WSL.' >&2
  exit 1
fi
command -v docker >/dev/null
owned="$(mktemp -d "${TMPDIR:-/tmp}/along-contracts.XXXXXX")"
token="$(basename "$owned")"
image="along-contracts:$token"
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
  if docker image inspect "$image" >/dev/null 2>&1; then
    docker image rm "$image" || result=1
  fi
  rmdir "$owned" || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo '== D8 current-tree production native build =='
docker build --tag "$image" --file "$root/infra/docker/Dockerfile" "$root"
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
  "$image" sh -c '
    set -eu
    mkdir /tmp/d8-contracts
    bun test --parallel=4 --timeout 30000 --reporter=junit \
      --reporter-outfile /tmp/d8-contracts/report.xml \
      ./apps/api/test/contracts.test.ts ./apps/api/test/contracts \
      ./apps/api/test/integration/tool-invocations-nontransactional.test.ts \
      ./packages/contracts/test ./packages/stream-protocol/test
    bun scripts/check-gates-executable.mjs . /tmp/d8-contracts/report.xml
  '
