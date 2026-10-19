#!/usr/bin/env sh
# Apply migrations in sorted order. CI sets DATABASE_URL; locally fall back
# to the B-line postgres (COMPOSE_PROJECT_NAME=along-b7, DB_PORT=55432).
set -eu

port="${DB_PORT:-55432}"
if [ -n "${DATABASE_URL:-}" ]; then
  dsn="$DATABASE_URL"
else
  dsn="postgresql://along:along@localhost:${port}/along"
fi

dir="$(dirname "$0")/../../infra/migrations"
count=0
for f in "$dir"/*.sql; do
  echo "== applying $(basename "$f")"
  psql "$dsn" -v ON_ERROR_STOP=1 -f "$f"
  count=$((count + 1))
done
echo "applied $count migration(s)"
