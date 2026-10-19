-- conversation.test.sql: red/green contract tests for 0002 (issue #28, D6).
-- Run against a throwaway database. Each RED block expects a specific
-- failure; unexpected success raises P0999. Wrap the whole file in a
-- transaction that is rolled back so the database is left clean.
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/conversation.test.sql

BEGIN;

-- GREEN: conversation + messages round trip.
INSERT INTO conversations (id, owner_id, title)
VALUES ('10000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'green');

INSERT INTO messages (id, owner_id, conversation_id, role, content, request_id)
VALUES ('10000000-0000-0000-0000-000000000011', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '10000000-0000-0000-0000-000000000001', 'user', 'remind me at 9', 'req-1');

-- GREEN: NULL request_id may repeat (partial uniqueness).
INSERT INTO messages (id, owner_id, conversation_id, role, content, request_id)
VALUES ('10000000-0000-0000-0000-000000000012', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '10000000-0000-0000-0000-000000000001', 'assistant', 'noted', NULL);
INSERT INTO messages (id, owner_id, conversation_id, role, content, request_id)
VALUES ('10000000-0000-0000-0000-000000000013', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '10000000-0000-0000-0000-000000000001', 'assistant', 'noted again', NULL);

-- GREEN: revision + prompt version + run chain.
INSERT INTO prompt_versions (id, name, version, content_hash)
VALUES ('10000000-0000-0000-0000-000000000021', 'confirm_preview', 'v1', 'hash-v1');

INSERT INTO agent_revisions (id, owner_id, name, revision, prompt_version)
VALUES ('10000000-0000-0000-0000-000000000022', NULL, 'assistant', 'r1', 'v1');

-- agent_runs.agent_revision is a logical reference: unpublished value inserts fine.
INSERT INTO agent_runs (id, owner_id, conversation_id, agent_revision, mode, budget_max_iterations, budget_max_tokens)
VALUES ('10000000-0000-0000-0000-000000000031', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '10000000-0000-0000-0000-000000000001', 'r-unpublished', 'task', 5, 2000);

INSERT INTO run_attempts (id, owner_id, run_id, attempt_no)
VALUES ('10000000-0000-0000-0000-000000000041', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '10000000-0000-0000-0000-000000000031', 1);

INSERT INTO run_checkpoints (id, owner_id, attempt_id, seq, kind, stream_protocol_version)
SELECT md5('c6-green-' || g.i)::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       '10000000-0000-0000-0000-000000000041', g.i, g.k, '0.1.0'
FROM (VALUES (1, 'thinking'), (2, 'tool_call'), (3, 'tool_result'),
             (4, 'approval_required'), (5, 'answer')) AS g(i, k);

-- GREEN (#9 interface): run -> attempt -> checkpoint chain reads back.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
  FROM agent_runs r
  JOIN run_attempts a ON a.run_id = r.id
  JOIN run_checkpoints c ON c.attempt_id = a.id
  WHERE r.id = '10000000-0000-0000-0000-000000000031';
  IF n <> 5 THEN
    RAISE EXCEPTION 'D6-FAIL: run/attempt/checkpoint join returned %, want 5', n USING ERRCODE = 'P0999';
  END IF;
  RAISE NOTICE '#9 interface ok: run/attempt/checkpoint chain readable (%)', n;
END;
$$;

-- RED: duplicate non-null request_id must fail.
DO $$
BEGIN
  BEGIN
    INSERT INTO messages (id, owner_id, conversation_id, role, content, request_id)
    VALUES ('10000000-0000-0000-0000-000000000014', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            '10000000-0000-0000-0000-000000000001', 'user', 'dup', 'req-1');
    RAISE EXCEPTION 'D6-FAIL: duplicate request_id unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'D6 ok: duplicate request_id rejected (%)', SQLSTATE;
  END;
END;
$$;

-- RED: duplicate (run_id, attempt_no) must fail.
DO $$
BEGIN
  BEGIN
    INSERT INTO run_attempts (id, owner_id, run_id, attempt_no)
    VALUES ('10000000-0000-0000-0000-000000000042', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            '10000000-0000-0000-0000-000000000031', 1);
    RAISE EXCEPTION 'D6-FAIL: duplicate attempt_no unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'D6 ok: duplicate attempt_no rejected (%)', SQLSTATE;
  END;
END;
$$;

-- RED: duplicate (attempt_id, seq) must fail.
DO $$
BEGIN
  BEGIN
    INSERT INTO run_checkpoints (id, owner_id, attempt_id, seq, kind, stream_protocol_version)
    VALUES ('10000000-0000-0000-0000-000000000051', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            '10000000-0000-0000-0000-000000000041', 1, 'thinking', '0.1.0');
    RAISE EXCEPTION 'D6-FAIL: duplicate checkpoint seq unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'D6 ok: duplicate checkpoint seq rejected (%)', SQLSTATE;
  END;
END;
$$;

-- RED: duplicate (name, revision) must fail.
DO $$
BEGIN
  BEGIN
    INSERT INTO agent_revisions (id, owner_id, name, revision, prompt_version)
    VALUES ('10000000-0000-0000-0000-000000000023', NULL, 'assistant', 'r1', 'v1');
    RAISE EXCEPTION 'D6-FAIL: duplicate revision unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'D6 ok: duplicate revision rejected (%)', SQLSTATE;
  END;
END;
$$;

-- RED: duplicate (name, version) must fail.
DO $$
BEGIN
  BEGIN
    INSERT INTO prompt_versions (id, name, version, content_hash)
    VALUES ('10000000-0000-0000-0000-000000000024', 'confirm_preview', 'v1', 'hash-v1-dup');
    RAISE EXCEPTION 'D6-FAIL: duplicate prompt version unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'D6 ok: duplicate prompt version rejected (%)', SQLSTATE;
  END;
END;
$$;

-- RED: illegal enum values must fail the checks.
DO $$
DECLARE
  bad_status text;
  bad_role text;
  bad_mode text;
  bad_kind text;
BEGIN
  FOREACH bad_status IN ARRAY ARRAY['archived', 'draft'] LOOP
    BEGIN
      INSERT INTO conversations (id, owner_id, status)
      VALUES (md5(bad_status)::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', bad_status);
      RAISE EXCEPTION 'D6-FAIL: illegal conversation status % unexpectedly succeeded', bad_status USING ERRCODE = 'P0999';
    EXCEPTION
      WHEN check_violation THEN
        RAISE NOTICE 'D6 ok: illegal conversation status % rejected (%)', bad_status, SQLSTATE;
    END;
  END LOOP;
  FOREACH bad_role IN ARRAY ARRAY['tool', 'function'] LOOP
    BEGIN
      INSERT INTO messages (id, owner_id, conversation_id, role, content)
      VALUES (md5(bad_role)::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              '10000000-0000-0000-0000-000000000001', bad_role, 'x');
      RAISE EXCEPTION 'D6-FAIL: illegal message role % unexpectedly succeeded', bad_role USING ERRCODE = 'P0999';
    EXCEPTION
      WHEN check_violation THEN
        RAISE NOTICE 'D6 ok: illegal message role % rejected (%)', bad_role, SQLSTATE;
    END;
  END LOOP;
  FOREACH bad_mode IN ARRAY ARRAY['brief', 'plan'] LOOP
    BEGIN
      INSERT INTO agent_runs (id, owner_id, conversation_id, agent_revision, mode, budget_max_iterations, budget_max_tokens)
      VALUES (md5(bad_mode)::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              '10000000-0000-0000-0000-000000000001', 'r1', bad_mode, 5, 2000);
      RAISE EXCEPTION 'D6-FAIL: illegal run mode % unexpectedly succeeded', bad_mode USING ERRCODE = 'P0999';
    EXCEPTION
      WHEN check_violation THEN
        RAISE NOTICE 'D6 ok: illegal run mode % rejected (%)', bad_mode, SQLSTATE;
    END;
  END LOOP;
  FOREACH bad_kind IN ARRAY ARRAY['delta', 'event'] LOOP
    BEGIN
      INSERT INTO run_checkpoints (id, owner_id, attempt_id, seq, kind, stream_protocol_version)
      VALUES (md5(bad_kind)::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              '10000000-0000-0000-0000-000000000041', 90 + length(bad_kind), bad_kind, '0.1.0');
      RAISE EXCEPTION 'D6-FAIL: illegal checkpoint kind % unexpectedly succeeded', bad_kind USING ERRCODE = 'P0999';
    EXCEPTION
      WHEN check_violation THEN
        RAISE NOTICE 'D6 ok: illegal checkpoint kind % rejected (%)', bad_kind, SQLSTATE;
    END;
  END LOOP;
END;
$$;

-- RED: UPDATE/DELETE on immutable tables must be rejected by the triggers.
-- WHERE targets a real row so the row-level trigger fires; the P0999 sentinel
-- surfaces a missing/disabled trigger as failure instead of a false 'ok'.
DO $$
BEGIN
  BEGIN
    UPDATE agent_revisions SET tools_allowlist = '["x"]'
    WHERE id = '10000000-0000-0000-0000-000000000022';
    RAISE EXCEPTION 'D6-FAIL: agent_revisions UPDATE unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLSTATE = 'P0999' THEN RAISE;
      ELSIF SQLSTATE = 'P0001' THEN RAISE NOTICE 'D6 ok: agent_revisions UPDATE rejected (%)', SQLSTATE;
      ELSE RAISE;
      END IF;
  END;
  BEGIN
    DELETE FROM agent_revisions WHERE id = '10000000-0000-0000-0000-000000000022';
    RAISE EXCEPTION 'D6-FAIL: agent_revisions DELETE unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLSTATE = 'P0999' THEN RAISE;
      ELSIF SQLSTATE = 'P0001' THEN RAISE NOTICE 'D6 ok: agent_revisions DELETE rejected (%)', SQLSTATE;
      ELSE RAISE;
      END IF;
  END;
END;
$$;

DO $$
BEGIN
  BEGIN
    UPDATE prompt_versions SET content_hash = 'tampered'
    WHERE id = '10000000-0000-0000-0000-000000000021';
    RAISE EXCEPTION 'D6-FAIL: prompt_versions UPDATE unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLSTATE = 'P0999' THEN RAISE;
      ELSIF SQLSTATE = 'P0001' THEN RAISE NOTICE 'D6 ok: prompt_versions UPDATE rejected (%)', SQLSTATE;
      ELSE RAISE;
      END IF;
  END;
  BEGIN
    DELETE FROM prompt_versions WHERE id = '10000000-0000-0000-0000-000000000021';
    RAISE EXCEPTION 'D6-FAIL: prompt_versions DELETE unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLSTATE = 'P0999' THEN RAISE;
      ELSIF SQLSTATE = 'P0001' THEN RAISE NOTICE 'D6 ok: prompt_versions DELETE rejected (%)', SQLSTATE;
      ELSE RAISE;
      END IF;
  END;
END;
$$;

DO $$
BEGIN
  BEGIN
    UPDATE run_checkpoints SET kind = 'answer'
    WHERE id = md5('c6-green-1')::uuid;
    RAISE EXCEPTION 'D6-FAIL: run_checkpoints UPDATE unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLSTATE = 'P0999' THEN RAISE;
      ELSIF SQLSTATE = 'P0001' THEN RAISE NOTICE 'D6 ok: run_checkpoints UPDATE rejected (%)', SQLSTATE;
      ELSE RAISE;
      END IF;
  END;
  BEGIN
    DELETE FROM run_checkpoints WHERE id = md5('c6-green-1')::uuid;
    RAISE EXCEPTION 'D6-FAIL: run_checkpoints DELETE unexpectedly succeeded' USING ERRCODE = 'P0999';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLSTATE = 'P0999' THEN RAISE;
      ELSIF SQLSTATE = 'P0001' THEN RAISE NOTICE 'D6 ok: run_checkpoints DELETE rejected (%)', SQLSTATE;
      ELSE RAISE;
      END IF;
  END;
END;
$$;

-- GREEN: mutable conversation rows still accept UPDATE (trigger scope check).
UPDATE conversations SET title = 'renamed'
WHERE id = '10000000-0000-0000-0000-000000000001';
UPDATE agent_runs SET status = 'done', ended_at = now()
WHERE id = '10000000-0000-0000-0000-000000000031';

ROLLBACK;
