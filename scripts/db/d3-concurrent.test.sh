#!/usr/bin/env sh
# d3-concurrent.test.sh: D3 concurrent dual-write proof (issue #7 acceptance,
# docs/design/13 D3). Two simultaneous sessions INSERT the same task
# (id, fire_at_utc); exactly one must win and the other must hit
# unique_violation (SQLSTATE 23505), and the table must hold exactly one row.
# No sleeps or lock-step: the loser blocks on the winner's uncommitted key and
# fails on commit either way, so the WIN/23505 split is order-independent.
#
# Usage: sh scripts/db/d3-concurrent.test.sh
#   Honors DATABASE_URL, else the B-line local postgres
#   (COMPOSE_PROJECT_NAME=along-b7, DB_PORT=55432). Uses host psql when
#   available (CI), else docker exec into the compose postgres container.
set -eu

TASK_ID="c0000000-0000-0000-0000-0000000000c1"
SOURCE_ID="d0000000-0000-0000-0000-0000000000d1"
FIRE_AT="2026-10-22T01:20:00Z"

if command -v psql >/dev/null 2>&1; then
  port="${DB_PORT:-55432}"
  if [ -n "${DATABASE_URL:-}" ]; then dsn="$DATABASE_URL"; else dsn="postgresql://along:along@localhost:${port}/along"; fi
  # shellcheck disable=SC2089
  run_psql() { psql "$dsn" -v ON_ERROR_STOP=1 -X -q -t -A "$@"; }
else
  ctr="${CONTAINER:-$(docker ps -q --filter label=com.docker.compose.project=along-b7 --filter label=com.docker.compose.service=postgres | head -n 1)}"
  [ -n "$ctr" ] || { echo "concurrent FAIL: no running along-b7 postgres container (and no host psql)" >&2; exit 1; }
  run_psql() { docker exec -i "$ctr" psql -U along -d along -v ON_ERROR_STOP=1 -X -q -t -A "$@"; }
fi

ATTEMPT_SQL="DO \$\$
BEGIN
  INSERT INTO tasks (id, owner_id, fire_at_utc, wall_time, timezone_id, fold, resolved_utc_offset_seconds, tzdb_version, source_approval_id)
  VALUES ('$TASK_ID', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '$FIRE_AT',
          '2026-10-22 09:20:00', 'Asia/Shanghai', 0, 28800, '2024a', '$SOURCE_ID');
  RAISE NOTICE 'CONCURRENT-WIN';
EXCEPTION
  WHEN unique_violation THEN
    RAISE NOTICE 'CONCURRENT-23505 %', SQLSTATE;
END \$\$;"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT INT TERM

run_psql -c "DELETE FROM tasks WHERE id = '$TASK_ID'; DELETE FROM approvals WHERE id = '$SOURCE_ID';" >/dev/null
# New tasks require exactly one real creation source.
run_psql -c "INSERT INTO approvals (id, owner_id, original_text, fire_at_utc, wall_time, timezone_id, fold, resolved_utc_offset_seconds, tzdb_version, occurrence, presentation_hash, presentation_version, state, expires_at) VALUES ('$SOURCE_ID', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'fixture source', '$FIRE_AT', '2026-10-22 09:20:00', 'Asia/Shanghai', 0, 28800, '2024a', 'single', 'ph_concurrent_source', 'v1', 'consumed', '2099-01-01T00:00:00Z');" >/dev/null

run_psql -c "$ATTEMPT_SQL" >"$tmpdir/a.log" 2>&1 &
pid_a=$!
run_psql -c "$ATTEMPT_SQL" >"$tmpdir/b.log" 2>&1 &
pid_b=$!
wait "$pid_a"
wait "$pid_b"

combined="$(cat "$tmpdir/a.log" "$tmpdir/b.log")"
wins="$(printf '%s\n' "$combined" | grep -c 'CONCURRENT-WIN' || true)"
conflicts="$(printf '%s\n' "$combined" | grep -c 'CONCURRENT-23505 23505' || true)"
rows="$(run_psql -c "SELECT count(*) FROM tasks WHERE id = '$TASK_ID';")"

run_psql -c "DELETE FROM tasks WHERE id = '$TASK_ID'; DELETE FROM approvals WHERE id = '$SOURCE_ID';" >/dev/null

if [ "$wins" = "1" ] && [ "$conflicts" = "1" ] && [ "$rows" = "1" ]; then
  echo "D3 ok: concurrent dual-write resolved to one win + one 23505 (rows=$rows)"
else
  printf '%s\n' "$combined" >&2
  echo "concurrent FAIL: wins=$wins conflicts=$conflicts rows=$rows (want 1/1/1)" >&2
  exit 1
fi
