#!/usr/bin/env bash
# Full CI: run independent database, native contract and fresh Compose checks.
set -euo pipefail

scope="${CI_SCOPE:-full}"
if [[ "$scope" != api && "$scope" != api-tests ]]; then scope=full; fi

run_database_checks() (
  set -euo pipefail
  local postgres="along-ci-postgres-$$"
  docker run -d --rm --name "$postgres" \
    -e POSTGRES_USER=along -e POSTGRES_PASSWORD=along -e POSTGRES_DB=along \
    -p 5432:5432 postgres:16-alpine >/dev/null
  trap 'docker rm -f "$postgres" >/dev/null 2>&1 || true' EXIT
  local ready=false
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
    return 1
  fi
  export DATABASE_URL=postgresql://along:along@localhost:5432/along
  export BETTER_AUTH_SECRET=ci-only-secret-for-identity-tests
  sh scripts/db/apply.sh
  if [[ "$scope" == api-tests ]]; then
    local -a api_tests
    read -r -a api_tests <<< "${CI_API_TESTS:-}"
    if (( ${#api_tests[@]} == 0 )); then
      echo 'No API integration tests selected' >&2
      return 1
    fi
    for test in "${api_tests[@]}"; do
      if [[ ! "$test" =~ ^apps/api/test/integration/[a-z0-9-]+\.test\.ts$ || ! -f "$test" ]]; then
        echo "Invalid selected API test: $test" >&2
        return 1
      fi
    done
    bun run build:api
    bun test --parallel=4 --timeout 30000 "${api_tests[@]}"
    return
  fi
  bun scripts/check-migrations.mjs
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/verify-constraints.sql
  if [[ "$scope" == full ]]; then
    bun --no-env-file test scripts/test/local-routing-database.test.ts
    bun --no-env-file test --parallel=2 scripts/test/local-goal-database.test.ts scripts/test/local-direct-reminder-database.test.ts scripts/test/local-invited-database.test.ts scripts/test/local-116-convergence.test.ts
  else
    echo 'Skipping historical upgrade tests for API module changes'
  fi
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/verify-conversation.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/d3-d5.test.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/conversation.test.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/verify-agent-support.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/agent-support.test.sql
  sh scripts/db/d3-concurrent.test.sh
  bun run build
  bun run --filter @along/api test:integration
)

run_database_checks &
database_pid=$!
if [[ "$scope" != api-tests ]]; then
  bun run test:contracts &
  contracts_pid=$!
  env -u DATABASE_URL -u TZDB_VERSION COMPOSE_PROJECT_NAME="along-ci-smoke-${GITHUB_RUN_ID:-$$}" sh scripts/compose-smoke.sh &
  compose_pid=$!
fi

result=0
for pid in "$database_pid" ${contracts_pid:+"$contracts_pid"} ${compose_pid:+"$compose_pid"}; do
  if ! wait "$pid"; then result=1; fi
done
exit "$result"
