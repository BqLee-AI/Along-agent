-- d3-d5.test.sql: red/green contract tests for D3/D4/D5.
-- Run against a throwaway database. Each block expects a specific failure;
-- unexpected success raises. Wrap the whole file in a transaction that is
-- rolled back so the database is left clean.
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/d3-d5.test.sql

BEGIN;

-- Every new task row requires exactly one real creation source; this seeded
-- approval is the source for the task fixtures below.
INSERT INTO approvals (id, owner_id, original_text, fire_at_utc, wall_time, timezone_id,
  fold, resolved_utc_offset_seconds, tzdb_version, occurrence, presentation_hash,
  presentation_version, state, expires_at)
VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'fixture source', '2026-10-17T01:20:00Z', '2026-10-17 09:20:00', 'Asia/Shanghai', 0,
  28800, '2024a', 'single', 'ph_fixture_source', 'v1', 'consumed', '2099-01-01T00:00:00Z');

-- D3 green: one task row inserts fine.
INSERT INTO tasks (id, owner_id, fire_at_utc, wall_time, timezone_id, fold, resolved_utc_offset_seconds, tzdb_version, source_approval_id)
VALUES ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '2026-10-17T01:20:00Z', '2026-10-17 09:20:00', 'Asia/Shanghai', 0, 28800, '2024a', 'dddddddd-dddd-dddd-dddd-dddddddddddd');

-- D3 red: same id must fail (PK; composite unique(id, fire_at_utc) also covers it).
DO $$
BEGIN
  BEGIN
    INSERT INTO tasks (id, owner_id, fire_at_utc, wall_time, timezone_id, fold, resolved_utc_offset_seconds, tzdb_version, source_approval_id)
    VALUES ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            '2026-10-17T01:20:00Z', '2026-10-17 09:20:00', 'Asia/Shanghai', 0, 28800, '2024a', 'dddddddd-dddd-dddd-dddd-dddddddddddd');
    RAISE EXCEPTION 'D3-FAIL: duplicate task id insert unexpectedly succeeded';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'D3 ok: duplicate task id rejected (%)', SQLSTATE;
  END;
END;
$$;

-- D4 red: second successor of the same old task must fail.
INSERT INTO tasks (id, owner_id, recreated_from_task_id, fire_at_utc, wall_time, timezone_id, fold, resolved_utc_offset_seconds, tzdb_version, source_approval_id)
VALUES ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '33333333-3333-3333-3333-333333333333', '2026-10-18T01:20:00Z', '2026-10-18 09:20:00', 'Asia/Shanghai', 0, 28800, '2024a', 'dddddddd-dddd-dddd-dddd-dddddddddddd');
DO $$
BEGIN
  BEGIN
    INSERT INTO tasks (id, owner_id, recreated_from_task_id, fire_at_utc, wall_time, timezone_id, fold, resolved_utc_offset_seconds, tzdb_version, source_approval_id)
    VALUES ('44444444-4444-4444-4444-444444444444', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            '33333333-3333-3333-3333-333333333333', '2026-10-19T01:20:00Z', '2026-10-19 09:20:00', 'Asia/Shanghai', 0, 28800, '2024a', 'dddddddd-dddd-dddd-dddd-dddddddddddd');
    RAISE EXCEPTION 'D4-FAIL: second successor unexpectedly succeeded';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'D4 ok: second successor rejected (%)', SQLSTATE;
  END;
END;
$$;

-- D4 green: NULL recreated_from_task_id may repeat.
INSERT INTO tasks (id, owner_id, fire_at_utc, wall_time, timezone_id, fold, resolved_utc_offset_seconds, tzdb_version, source_approval_id)
VALUES ('55555555-5555-5555-5555-555555555555', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '2026-10-20T01:20:00Z', '2026-10-20 09:20:00', 'Asia/Shanghai', 0, 28800, '2024a', 'dddddddd-dddd-dddd-dddd-dddddddddddd');

-- D3/D4 red: illegal state / kind must fail the check.
DO $$
BEGIN
  BEGIN
    INSERT INTO tasks (id, owner_id, state, fire_at_utc, wall_time, timezone_id, fold, resolved_utc_offset_seconds, tzdb_version, source_approval_id)
    VALUES ('66666666-6666-6666-6666-666666666666', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bogus_state',
            '2026-10-21T01:20:00Z', '2026-10-21 09:20:00', 'Asia/Shanghai', 0, 28800, '2024a', 'dddddddd-dddd-dddd-dddd-dddddddddddd');
    RAISE EXCEPTION 'D3-FAIL: illegal task state unexpectedly succeeded';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'D-check ok: illegal task state rejected (%)', SQLSTATE;
  END;
END;
$$;

-- D5 green: each of the seven closed-vocabulary event types inserts fine.
INSERT INTO task_events (id, owner_id, task_id, state_version, type)
SELECT md5('d5-green-' || g.i)::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       '11111111-1111-1111-1111-111111111111', g.i, g.t
FROM (VALUES (1, 'created'), (2, 'scheduled'), (3, 'fired'), (4, 'missed'),
             (5, 'cancel_requested'), (6, 'cancelled'), (7, 'reconciliation_run')) AS g(i, t);

-- D5 red: out-of-vocabulary types must fail the check.
DO $$
DECLARE
  bad text;
BEGIN
  FOREACH bad IN ARRAY ARRAY['saved', 'superseded', 'ack_unknown'] LOOP
    BEGIN
      INSERT INTO task_events (id, owner_id, task_id, state_version, type)
      VALUES (md5(bad)::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              '11111111-1111-1111-1111-111111111111', 99, bad);
      RAISE EXCEPTION 'D5-FAIL: illegal event type % unexpectedly succeeded', bad;
    EXCEPTION
      WHEN check_violation THEN
        RAISE NOTICE 'D5 ok: illegal event type % rejected (%)', bad, SQLSTATE;
    END;
  END LOOP;
END;
$$;

-- D5 red: UPDATE and DELETE on task_events must be rejected by the trigger.
-- WHERE targets a real row (md5('d5-green-1')::uuid) so the row-level trigger
-- fires; the sentinel uses ERRCODE P0999 so a missing/disabled trigger
-- surfaces as failure instead of a false 'ok'.
DO $$
BEGIN
  BEGIN
    UPDATE task_events SET evidence_ref = 'tampered'
    WHERE id = md5('d5-green-1')::uuid;
    RAISE EXCEPTION 'D5-FAIL: task_events UPDATE unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLSTATE = 'P0999' THEN
        RAISE;
      ELSIF SQLSTATE = 'P0001' THEN
        RAISE NOTICE 'D5 ok: task_events UPDATE rejected (%)', SQLSTATE;
      ELSE
        RAISE;
      END IF;
  END;
  BEGIN
    DELETE FROM task_events WHERE id = md5('d5-green-1')::uuid;
    RAISE EXCEPTION 'D5-FAIL: task_events DELETE unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLSTATE = 'P0999' THEN
        RAISE;
      ELSIF SQLSTATE = 'P0001' THEN
        RAISE NOTICE 'D5 ok: task_events DELETE rejected (%)', SQLSTATE;
      ELSE
        RAISE;
      END IF;
  END;
END;
$$;

ROLLBACK;
