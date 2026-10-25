-- agent-support.test.sql: red/green contract tests for 0011 (issue #9, D6).
-- Run against a throwaway database. Each RED block expects a specific
-- failure; unexpected success raises P0999. Wrap the whole file in a
-- transaction that is rolled back so the database is left clean.
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/agent-support.test.sql

BEGIN;

-- Seed chain: user -> conversation -> run -> attempt.
INSERT INTO users (id, display_name, auth_email)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'agent-test', 'agent-test@local.invalid')
ON CONFLICT (id) DO NOTHING;

INSERT INTO conversations (id, owner_id, title)
VALUES ('20000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'agent');

INSERT INTO messages (id, owner_id, conversation_id, role, content, request_id)
VALUES ('20000000-0000-0000-0000-000000000011', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '20000000-0000-0000-0000-000000000001', 'user', 'remind me', 'agent-req-1');

INSERT INTO agent_runs (id, owner_id, conversation_id, agent_revision, mode, budget_max_iterations, budget_max_tokens)
VALUES ('20000000-0000-0000-0000-000000000031', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '20000000-0000-0000-0000-000000000001', 'assistant/r-test', 'task', 5, 2000);

INSERT INTO run_attempts (id, owner_id, run_id, attempt_no)
VALUES ('20000000-0000-0000-0000-000000000041', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '20000000-0000-0000-0000-000000000031', 1);

-- GREEN: idempotency row round trip.
INSERT INTO conversation_idempotency (owner_id, idempotency_key, request_hash, conversation_id, run_id, user_message_id, expires_at)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'idem-1', 'hash-1',
        '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000031',
        '20000000-0000-0000-0000-000000000011', now() + interval '24 hours');

-- GREEN: tool_calls allow row + new thread kinds + event_seq assigned.
INSERT INTO tool_calls (id, owner_id, run_id, attempt_id, tool_id, args_hash, decision)
VALUES ('20000000-0000-0000-0000-000000000051', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '20000000-0000-0000-0000-000000000031', '20000000-0000-0000-0000-000000000041',
        'propose_task', 'args-1', 'allow');

INSERT INTO run_checkpoints (id, owner_id, attempt_id, seq, kind, stream_protocol_version)
VALUES ('20000000-0000-0000-0000-000000000061', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '20000000-0000-0000-0000-000000000041', 1, 'thread.started', 'v1'),
       ('20000000-0000-0000-0000-000000000062', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '20000000-0000-0000-0000-000000000041', 2, 'message.delta', 'v1'),
       ('20000000-0000-0000-0000-000000000063', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '20000000-0000-0000-0000-000000000041', 3, 'approval_required', 'v1'),
       ('20000000-0000-0000-0000-000000000064', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '20000000-0000-0000-0000-000000000041', 4, 'thread.completed', 'v1');

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(DISTINCT event_seq) INTO n FROM run_checkpoints
  WHERE attempt_id = '20000000-0000-0000-0000-000000000041';
  IF n <> 4 THEN
    RAISE EXCEPTION 'D6-FAIL: event_seq not distinct per checkpoint (%)', n USING ERRCODE = 'P0999';
  END IF;
  RAISE NOTICE '#9 green ok: thread kinds + distinct event_seq (%)', n;
END;
$$;

-- RED: duplicate (owner_id, idempotency_key) must fail.
DO $$
BEGIN
  BEGIN
    INSERT INTO conversation_idempotency (owner_id, idempotency_key, request_hash, conversation_id, run_id, expires_at)
    VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'idem-1', 'hash-2',
            '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000031',
            now() + interval '24 hours');
    RAISE EXCEPTION 'D6-FAIL: duplicate idempotency key unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'D6 ok: duplicate idempotency key rejected (%)', SQLSTATE;
  END;
END;
$$;

-- GREEN: equal args are not an invocation identity; audit rows may repeat.
INSERT INTO tool_calls (id, owner_id, run_id, attempt_id, tool_id, args_hash, decision)
VALUES ('20000000-0000-0000-0000-000000000052', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '20000000-0000-0000-0000-000000000031', '20000000-0000-0000-0000-000000000041',
        'propose_task', 'args-1', 'allow');

INSERT INTO tool_invocations (invocation_id, owner_id, conversation_id, run_id, call_key,
  first_attempt_id, first_request_id, tool_id, args_hash, args_bytes, execution_kind, frozen_context)
VALUES ('20000000-0000-0000-0000-000000000071', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000031', 'action/1',
  '20000000-0000-0000-0000-000000000041', 'request-1', 'propose_task', repeat('a',64), 2, 'local', '{}'),
  ('20000000-0000-0000-0000-000000000072', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000031', 'action/2',
  '20000000-0000-0000-0000-000000000041', 'request-2', 'propose_task', repeat('a',64), 2, 'local', '{}');

-- RED: the same durable Run/slot cannot reserve a second identity.
DO $$
BEGIN
  BEGIN
    INSERT INTO tool_invocations (invocation_id, owner_id, conversation_id, run_id, call_key,
      first_attempt_id, first_request_id, tool_id, args_hash, args_bytes, execution_kind, frozen_context)
    VALUES (gen_random_uuid(), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000031', 'action/1',
      '20000000-0000-0000-0000-000000000041', 'request-3', 'propose_task', repeat('b',64), 2, 'local', '{}');
    RAISE EXCEPTION 'D6-FAIL: duplicate logical call slot unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'D6 ok: duplicate logical call slot rejected (%)', SQLSTATE;
  END;
END;
$$;

-- RED: illegal tool_calls decision must fail the check.
DO $$
BEGIN
  BEGIN
    INSERT INTO tool_calls (id, owner_id, run_id, tool_id, args_hash, decision)
    VALUES ('20000000-0000-0000-0000-000000000053', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            '20000000-0000-0000-0000-000000000031', 'propose_task', 'args-9', 'pending');
    RAISE EXCEPTION 'D6-FAIL: illegal tool decision unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'D6 ok: illegal tool decision rejected (%)', SQLSTATE;
  END;
END;
$$;

-- RED: legacy forbidden kinds ('delta', 'event') still fail.
DO $$
DECLARE
  bad_kind text;
BEGIN
  FOREACH bad_kind IN ARRAY ARRAY['delta', 'event'] LOOP
    BEGIN
      INSERT INTO run_checkpoints (id, owner_id, attempt_id, seq, kind, stream_protocol_version)
      VALUES (md5('agent-bad-' || bad_kind)::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              '20000000-0000-0000-0000-000000000041', 90 + length(bad_kind), bad_kind, 'v1');
      RAISE EXCEPTION 'D6-FAIL: illegal checkpoint kind % unexpectedly succeeded', bad_kind USING ERRCODE = 'P0999';
    EXCEPTION
      WHEN check_violation THEN
        RAISE NOTICE 'D6 ok: illegal checkpoint kind % rejected (%)', bad_kind, SQLSTATE;
    END;
  END LOOP;
END;
$$;

-- RED: UPDATE/DELETE on tool_calls must be rejected by the trigger (P0001).
DO $$
BEGIN
  BEGIN
    UPDATE tool_calls SET decision = 'deny'
    WHERE id = '20000000-0000-0000-0000-000000000051';
    RAISE EXCEPTION 'D6-FAIL: tool_calls UPDATE unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLSTATE = 'P0999' THEN RAISE;
      ELSIF SQLSTATE = 'P0001' THEN RAISE NOTICE 'D6 ok: tool_calls UPDATE rejected (%)', SQLSTATE;
      ELSE RAISE;
      END IF;
  END;
  BEGIN
    DELETE FROM tool_calls WHERE id = '20000000-0000-0000-0000-000000000051';
    RAISE EXCEPTION 'D6-FAIL: tool_calls DELETE unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLSTATE = 'P0999' THEN RAISE;
      ELSIF SQLSTATE = 'P0001' THEN RAISE NOTICE 'D6 ok: tool_calls DELETE rejected (%)', SQLSTATE;
      ELSE RAISE;
      END IF;
  END;
END;
$$;

-- GREEN: cancel_task approval round trip; RED: bad kind + bad target pair.
-- A cancel_task approval needs a real task row: create one under the seeded
-- user (notify_only, saved) so target_task_id has a RESTRICT-valid referent.
INSERT INTO tasks (id, owner_id, fire_at_utc, wall_time, timezone_id, fold,
  resolved_utc_offset_seconds, tzdb_version, occurrence, state)
VALUES ('20000000-0000-0000-0000-000000000071', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  now() + interval '2 hours', '2099-01-01 10:00', 'Asia/Shanghai', 0, 28800,
  'fixture-v1', 'once', 'saved');

INSERT INTO approvals (id, owner_id, conversation_id, original_text, fire_at_utc,
  wall_time, timezone_id, fold, resolved_utc_offset_seconds, tzdb_version,
  occurrence, presentation_hash, presentation_version, state, expires_at,
  kind, target_task_id, expected_state_version)
VALUES ('20000000-0000-0000-0000-000000000072', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '20000000-0000-0000-0000-000000000001', 'cancel that reminder',
  now() + interval '2 hours', '2099-01-01 10:00', 'Asia/Shanghai', 0, 28800,
  'fixture-v1', 'single', 'ph_cancel_test', 'v1', 'pending',
  now() + interval '24 hours', 'cancel_task',
  '20000000-0000-0000-0000-000000000071', 1);

DO $$
BEGIN
  -- RED: create_task must not carry a cancel target.
  BEGIN
    INSERT INTO approvals (id, owner_id, fire_at_utc, wall_time, timezone_id,
      fold, resolved_utc_offset_seconds, tzdb_version, occurrence,
      presentation_hash, presentation_version, state, expires_at, kind,
      target_task_id, expected_state_version)
    VALUES ('20000000-0000-0000-0000-000000000073', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      now() + interval '2 hours', '2099-01-01 10:00', 'Asia/Shanghai', 0, 28800,
      'fixture-v1', 'single', 'ph_bad', 'v1', 'pending', now() + interval '24 hours',
      'create_task', '20000000-0000-0000-0000-000000000071', NULL);
    RAISE EXCEPTION 'D6-FAIL: create_task with target unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'D6 ok: create_task with target rejected (%)', SQLSTATE;
  END;
  -- RED: cancel_task without a target must fail.
  BEGIN
    INSERT INTO approvals (id, owner_id, fire_at_utc, wall_time, timezone_id,
      fold, resolved_utc_offset_seconds, tzdb_version, occurrence,
      presentation_hash, presentation_version, state, expires_at, kind,
      target_task_id, expected_state_version)
    VALUES ('20000000-0000-0000-0000-000000000074', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      now() + interval '2 hours', '2099-01-01 10:00', 'Asia/Shanghai', 0, 28800,
      'fixture-v1', 'single', 'ph_bad', 'v1', 'pending', now() + interval '24 hours',
      'cancel_task', NULL, NULL);
    RAISE EXCEPTION 'D6-FAIL: cancel_task without target unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'D6 ok: cancel_task without target rejected (%)', SQLSTATE;
  END;
  -- RED: unknown kind must fail.
  BEGIN
    INSERT INTO approvals (id, owner_id, fire_at_utc, wall_time, timezone_id,
      fold, resolved_utc_offset_seconds, tzdb_version, occurrence,
      presentation_hash, presentation_version, state, expires_at, kind)
    VALUES ('20000000-0000-0000-0000-000000000075', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      now() + interval '2 hours', '2099-01-01 10:00', 'Asia/Shanghai', 0, 28800,
      'fixture-v1', 'single', 'ph_bad', 'v1', 'pending', now() + interval '24 hours',
      'reschedule_task');
    RAISE EXCEPTION 'D6-FAIL: unknown approval kind unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'D6 ok: unknown approval kind rejected (%)', SQLSTATE;
  END;
END;
$$;



-- RED: UPDATE/DELETE on run_checkpoints still rejected (0002 behavior kept).
DO $$
BEGIN
  BEGIN
    UPDATE run_checkpoints SET kind = 'answer'
    WHERE id = '20000000-0000-0000-0000-000000000061';
    RAISE EXCEPTION 'D6-FAIL: run_checkpoints UPDATE unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLSTATE = 'P0999' THEN RAISE;
      ELSIF SQLSTATE = 'P0001' THEN RAISE NOTICE 'D6 ok: run_checkpoints UPDATE rejected (%)', SQLSTATE;
      ELSE RAISE;
      END IF;
  END;
END;
$$;

-- GREEN: mutable idempotency rows accept expiry DELETE (cleanup path).
DELETE FROM conversation_idempotency
WHERE owner_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND idempotency_key = 'idem-1';

ROLLBACK;
