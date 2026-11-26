#!/usr/bin/env bash
# PostgreSQL-only checks; native consumers run in the production image instead.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
scope="${CI_SCOPE:-full}"
if [[ "$scope" != api && "$scope" != api-tests ]]; then scope=full; fi
postgres="along-ci-postgres-$$"
build_pid=''
cleanup() {
  local result=$?
  trap - EXIT
  if [[ -n "$build_pid" ]]; then
    kill -TERM -- "-$build_pid" 2>/dev/null || true
    wait "$build_pid" 2>/dev/null || true
  fi
  docker rm -f "$postgres" >/dev/null 2>&1 || true
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run -d --rm --name "$postgres" \
  -e POSTGRES_USER=along -e POSTGRES_PASSWORD=along -e POSTGRES_DB=along \
  -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
ready=false
for _ in {1..60}; do
  if docker exec "$postgres" pg_isready -h 127.0.0.1 -U along -d along >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  docker logs "$postgres"
  echo 'CI PostgreSQL did not become ready' >&2
  exit 1
fi
port="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$postgres")"
export DATABASE_URL="postgresql://along:along@127.0.0.1:$port/along"
export BETTER_AUTH_SECRET=ci-only-secret-for-identity-tests
sh scripts/db/apply.sh
if [[ "$scope" == api-tests ]]; then
  read -r -a api_tests <<< "${CI_API_TESTS:-}"
  if (( ${#api_tests[@]} == 0 )); then
    echo 'No API integration tests selected' >&2
    exit 1
  fi
  for test in "${api_tests[@]}"; do
    if [[ ! "$test" =~ ^apps/api/test/integration/[a-z0-9-]+\.test\.ts$ || ! -f "$test" ]]; then
      echo "Invalid selected API test: $test" >&2
      exit 1
    fi
  done
  bun run build:api
  bun test --parallel=4 --timeout 30000 "${api_tests[@]}"
  exit
fi
# Compile while independent history databases are exercised; API tests wait below.
setsid bun run build:api &
build_pid=$!
bun scripts/check-migrations.mjs
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/verify-constraints.sql
if [[ "$scope" == full ]]; then
  bun --no-env-file test --parallel=2 \
    scripts/test/local-routing-database.test.ts \
    scripts/test/local-goal-database.test.ts \
    scripts/test/local-direct-reminder-database.test.ts \
    scripts/test/local-invited-database.test.ts \
    scripts/test/local-116-convergence.test.ts \
    scripts/test/local-personal-bot-database.test.ts
else
  echo 'Skipping historical upgrade tests for API module changes'
fi
for sql in verify-conversation.sql d3-d5.test.sql conversation.test.sql verify-agent-support.sql agent-support.test.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "scripts/db/$sql"
done
sh scripts/db/d3-concurrent.test.sh
wait "$build_pid"
build_pid=''
mapfile -t native_tests < ci/native-tests.txt
native_names=()
for test in "${native_tests[@]}"; do native_names+=("${test##*/}"); done
ignore="$(IFS=,; echo "${native_names[*]}")"
bun test --parallel=4 --timeout 30000 \
  --path-ignore-patterns "**/test/integration/{$ignore}" ./apps/api/test/integration
