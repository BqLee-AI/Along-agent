-- verify-agent-support.sql: structural assertions for 0011 (issue #9).
-- Run on a fresh DB after apply.sh. Raises NOTICE
-- 'agent support constraints verified' on success, RAISE EXCEPTION on the
-- first missing object.
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/verify-agent-support.sql
\set ON_ERROR_STOP on

DO $$
BEGIN
  -- Tables exist (2 new).
  PERFORM 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('conversation_idempotency', 'tool_calls');
  IF NOT FOUND THEN RAISE EXCEPTION 'agent support tables missing'; END IF;

  -- Primary keys.
  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'conversation_idempotency'::regclass AND contype = 'p'
      AND conname = 'conversation_idempotency_pkey';
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_idempotency pkey missing'; END IF;

  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'tool_calls'::regclass AND contype = 'p' AND conname = 'tool_calls_pkey';
  IF NOT FOUND THEN RAISE EXCEPTION 'tool_calls pkey missing'; END IF;

  -- Idempotency FKs (owner + conversation + run; user message nullable).
  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'conversation_idempotency'::regclass AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE '%REFERENCES users(id)%';
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_idempotency owner FK missing'; END IF;

  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'conversation_idempotency'::regclass AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE '%REFERENCES conversations(id)%ON DELETE RESTRICT%';
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_idempotency conversation FK missing'; END IF;

  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'conversation_idempotency'::regclass AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE '%REFERENCES agent_runs(id)%ON DELETE RESTRICT%';
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_idempotency run FK missing'; END IF;

  -- tool_calls FKs + checks.
  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'tool_calls'::regclass AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE '%REFERENCES agent_runs(id)%ON DELETE RESTRICT%';
  IF NOT FOUND THEN RAISE EXCEPTION 'tool_calls run FK missing'; END IF;

  PERFORM 1 FROM pg_constraint WHERE conname = 'tool_calls_decision_check';
  IF NOT FOUND THEN RAISE EXCEPTION 'tool_calls_decision_check missing'; END IF;

  PERFORM 1 FROM pg_constraint WHERE conname = 'tool_calls_invocation_uniq';
  IF NOT FOUND THEN RAISE EXCEPTION 'tool_calls_invocation_uniq missing'; END IF;

  -- run_checkpoints widened kind set still present under the same name.
  PERFORM 1 FROM pg_constraint WHERE conname = 'run_checkpoints_kind_check';
  IF NOT FOUND THEN RAISE EXCEPTION 'run_checkpoints_kind_check missing'; END IF;

  -- event_seq column + backing sequence + unique index.
  PERFORM 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'run_checkpoints' AND column_name = 'event_seq';
  IF NOT FOUND THEN RAISE EXCEPTION 'run_checkpoints.event_seq missing'; END IF;

  PERFORM 1 FROM pg_class WHERE relname = 'run_checkpoints_event_seq_seq' AND relkind = 'S';
  IF NOT FOUND THEN RAISE EXCEPTION 'run_checkpoints_event_seq_seq missing'; END IF;

  PERFORM 1 FROM pg_class WHERE relname = 'run_checkpoints_event_seq_uniq';
  IF NOT FOUND THEN RAISE EXCEPTION 'run_checkpoints_event_seq_uniq missing'; END IF;

  PERFORM 1 FROM pg_class WHERE relname = 'tool_calls_run_created_idx';
  IF NOT FOUND THEN RAISE EXCEPTION 'tool_calls_run_created_idx missing'; END IF;

  PERFORM 1 FROM pg_class WHERE relname = 'conversation_idempotency_expires_at_idx';
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_idempotency_expires_at_idx missing'; END IF;

  -- D6: tool_calls immutability trigger present and enabled.
  PERFORM 1 FROM pg_trigger
    WHERE tgrelid = 'tool_calls'::regclass AND tgname = 'tool_calls_no_update_delete' AND tgenabled = 'O';
  IF NOT FOUND THEN RAISE EXCEPTION 'tool_calls_no_update_delete trigger missing'; END IF;

  -- (d) approvals kind columns + checks + index.
  PERFORM 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'approvals' AND column_name = 'kind';
  IF NOT FOUND THEN RAISE EXCEPTION 'approvals.kind missing'; END IF;

  PERFORM 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'approvals' AND column_name = 'target_task_id';
  IF NOT FOUND THEN RAISE EXCEPTION 'approvals.target_task_id missing'; END IF;

  PERFORM 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'approvals' AND column_name = 'expected_state_version';
  IF NOT FOUND THEN RAISE EXCEPTION 'approvals.expected_state_version missing'; END IF;

  PERFORM 1 FROM pg_constraint WHERE conname = 'approvals_kind_check';
  IF NOT FOUND THEN RAISE EXCEPTION 'approvals_kind_check missing'; END IF;

  PERFORM 1 FROM pg_constraint WHERE conname = 'approvals_cancel_target_check';
  IF NOT FOUND THEN RAISE EXCEPTION 'approvals_cancel_target_check missing'; END IF;

  PERFORM 1 FROM pg_class WHERE relname = 'approvals_owner_kind_idx';
  IF NOT FOUND THEN RAISE EXCEPTION 'approvals_owner_kind_idx missing'; END IF;


  RAISE NOTICE 'agent support constraints verified';
END;
$$;
