#!/usr/bin/env bash
# Full CI: run independent database, native contract and fresh Compose checks.
set -euo pipefail

run_database_checks() (
  set -euo pipefail
  local postgres="along-ci-postgres-$$"
  docker run -d --rm --name "$postgres" \
    -e POSTGRES_USER=along -e POSTGRES_PASSWORD=along -e POSTGRES_DB=along \
    -p 5432:5432 postgres:16-alpine >/dev/null
  trap 'docker rm -f "$postgres" >/dev/null 2>&1 || true' EXIT
  local ready=false
  for _ in {1..60}; do
    if docker exec "$postgres" pg_isready -U along -d along >/dev/null 2>&1; then
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
  bun scripts/check-migrations.mjs
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/verify-constraints.sql
  bun --no-env-file test scripts/test/local-routing-database.test.ts
  bun --no-env-file test --parallel=2 scripts/test/local-goal-database.test.ts scripts/test/local-direct-reminder-database.test.ts scripts/test/local-invited-database.test.ts scripts/test/local-116-convergence.test.ts
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/verify-conversation.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/d3-d5.test.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/conversation.test.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/verify-agent-support.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/agent-support.test.sql
  sh scripts/db/d3-concurrent.test.sh
  bun run build
  bun run --filter @along/api test:integration
  bun run test:scheduler
)

run_database_checks &
database_pid=$!
bun run test:contracts &
contracts_pid=$!
env -u DATABASE_URL -u TZDB_VERSION COMPOSE_PROJECT_NAME="along-ci-smoke-${GITHUB_RUN_ID:-$$}" sh scripts/compose-smoke.sh &
compose_pid=$!

result=0
for pid in "$database_pid" "$contracts_pid" "$compose_pid"; do
  if ! wait "$pid"; then result=1; fi
done
exit "$result"
