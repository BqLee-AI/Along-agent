-- verify-conversation.sql: structural assertions for 0002 (issue #28, D6).
-- Run on a fresh DB after apply.sh. Raises NOTICE
-- 'conversation constraints verified' on success, RAISE EXCEPTION on the
-- first missing object.
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/verify-conversation.sql
\set ON_ERROR_STOP on

DO $$
DECLARE
  missing_count integer;
BEGIN
  -- Tables exist (7).
  PERFORM 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('conversations', 'messages', 'agent_runs', 'run_attempts',
                         'run_checkpoints', 'agent_revisions', 'prompt_versions');
  GET DIAGNOSTICS missing_count = ROW_COUNT;
  IF missing_count <> 7 THEN RAISE EXCEPTION 'conversation tables missing: found % of 7', missing_count; END IF;

  -- Primary keys.
  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'conversations'::regclass AND contype = 'p' AND conname = 'conversations_pkey';
  IF NOT FOUND THEN RAISE EXCEPTION 'conversations pkey missing'; END IF;

  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'messages'::regclass AND contype = 'p' AND conname = 'messages_pkey';
  IF NOT FOUND THEN RAISE EXCEPTION 'messages pkey missing'; END IF;

  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'agent_runs'::regclass AND contype = 'p' AND conname = 'agent_runs_pkey';
  IF NOT FOUND THEN RAISE EXCEPTION 'agent_runs pkey missing'; END IF;

  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'run_attempts'::regclass AND contype = 'p' AND conname = 'run_attempts_pkey';
  IF NOT FOUND THEN RAISE EXCEPTION 'run_attempts pkey missing'; END IF;

  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'run_checkpoints'::regclass AND contype = 'p' AND conname = 'run_checkpoints_pkey';
  IF NOT FOUND THEN RAISE EXCEPTION 'run_checkpoints pkey missing'; END IF;

  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'agent_revisions'::regclass AND contype = 'p' AND conname = 'agent_revisions_pkey';
  IF NOT FOUND THEN RAISE EXCEPTION 'agent_revisions pkey missing'; END IF;

  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'prompt_versions'::regclass AND contype = 'p' AND conname = 'prompt_versions_pkey';
  IF NOT FOUND THEN RAISE EXCEPTION 'prompt_versions pkey missing'; END IF;

  -- Module-internal FKs, all ON DELETE RESTRICT.
  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'messages'::regclass AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE '%REFERENCES conversations(id)%ON DELETE RESTRICT%';
  IF NOT FOUND THEN RAISE EXCEPTION 'messages conversation FK missing'; END IF;

  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'agent_runs'::regclass AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE '%REFERENCES conversations(id)%ON DELETE RESTRICT%';
  IF NOT FOUND THEN RAISE EXCEPTION 'agent_runs conversation FK missing'; END IF;

  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'run_attempts'::regclass AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE '%REFERENCES agent_runs(id)%ON DELETE RESTRICT%';
  IF NOT FOUND THEN RAISE EXCEPTION 'run_attempts run FK missing'; END IF;

  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'run_checkpoints'::regclass AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE '%REFERENCES run_attempts(id)%ON DELETE RESTRICT%';
  IF NOT FOUND THEN RAISE EXCEPTION 'run_checkpoints attempt FK missing'; END IF;

  -- Logical references only: agent_runs.agent_revision and
  -- agent_revisions.prompt_version must NOT be FKs.
  PERFORM 1 FROM pg_constraint
  WHERE conrelid IN ('agent_runs'::regclass, 'agent_revisions'::regclass)
      AND contype = 'f'
      AND (pg_get_constraintdef(oid) LIKE '%REFERENCES agent_revisions%'
        OR pg_get_constraintdef(oid) LIKE '%REFERENCES prompt_versions%');
  IF FOUND THEN RAISE EXCEPTION 'revision references must stay logical (no FK)'; END IF;

  -- Check constraints (enum closed sets).
  PERFORM 1 FROM pg_constraint WHERE conname = 'conversations_status_check';
  IF NOT FOUND THEN RAISE EXCEPTION 'conversations_status_check missing'; END IF;

  PERFORM 1 FROM pg_constraint WHERE conname = 'messages_role_check';
  IF NOT FOUND THEN RAISE EXCEPTION 'messages_role_check missing'; END IF;

  PERFORM 1 FROM pg_constraint WHERE conname = 'agent_runs_mode_check';
  IF NOT FOUND THEN RAISE EXCEPTION 'agent_runs_mode_check missing'; END IF;

  PERFORM 1 FROM pg_constraint WHERE conname = 'agent_runs_status_check';
  IF NOT FOUND THEN RAISE EXCEPTION 'agent_runs_status_check missing'; END IF;

  PERFORM 1 FROM pg_constraint WHERE conname = 'run_attempts_status_check';
  IF NOT FOUND THEN RAISE EXCEPTION 'run_attempts_status_check missing'; END IF;

  PERFORM 1 FROM pg_constraint WHERE conname = 'run_checkpoints_kind_check';
  IF NOT FOUND THEN RAISE EXCEPTION 'run_checkpoints_kind_check missing'; END IF;

  -- Unique constraints.
  PERFORM 1 FROM pg_constraint WHERE conname = 'messages_request_id_uniq';
  IF NOT FOUND THEN RAISE EXCEPTION 'messages_request_id_uniq missing'; END IF;

  PERFORM 1 FROM pg_constraint WHERE conname = 'run_attempts_run_attempt_no_uniq';
  IF NOT FOUND THEN RAISE EXCEPTION 'run_attempts_run_attempt_no_uniq missing'; END IF;

  PERFORM 1 FROM pg_constraint WHERE conname = 'run_checkpoints_attempt_seq_uniq';
  IF NOT FOUND THEN RAISE EXCEPTION 'run_checkpoints_attempt_seq_uniq missing'; END IF;

  PERFORM 1 FROM pg_constraint WHERE conname = 'agent_revisions_name_revision_uniq';
  IF NOT FOUND THEN RAISE EXCEPTION 'agent_revisions_name_revision_uniq missing'; END IF;

  PERFORM 1 FROM pg_constraint WHERE conname = 'prompt_versions_name_version_uniq';
  IF NOT FOUND THEN RAISE EXCEPTION 'prompt_versions_name_version_uniq missing'; END IF;

  -- Indexes.
  PERFORM 1 FROM pg_class WHERE relname = 'conversations_owner_created_idx';
  IF NOT FOUND THEN RAISE EXCEPTION 'conversations_owner_created_idx missing'; END IF;

  PERFORM 1 FROM pg_class WHERE relname = 'conversations_owner_status_idx';
  IF NOT FOUND THEN RAISE EXCEPTION 'conversations_owner_status_idx missing'; END IF;

  PERFORM 1 FROM pg_class WHERE relname = 'messages_conversation_created_idx';
  IF NOT FOUND THEN RAISE EXCEPTION 'messages_conversation_created_idx missing'; END IF;

  PERFORM 1 FROM pg_class WHERE relname = 'messages_owner_created_idx';
  IF NOT FOUND THEN RAISE EXCEPTION 'messages_owner_created_idx missing'; END IF;

  PERFORM 1 FROM pg_class WHERE relname = 'agent_runs_conversation_created_idx';
  IF NOT FOUND THEN RAISE EXCEPTION 'agent_runs_conversation_created_idx missing'; END IF;

  PERFORM 1 FROM pg_class WHERE relname = 'agent_runs_owner_status_idx';
  IF NOT FOUND THEN RAISE EXCEPTION 'agent_runs_owner_status_idx missing'; END IF;

  PERFORM 1 FROM pg_class WHERE relname = 'run_attempts_run_created_idx';
  IF NOT FOUND THEN RAISE EXCEPTION 'run_attempts_run_created_idx missing'; END IF;

  -- D6: immutability / append-only triggers present and enabled.
  PERFORM 1 FROM pg_trigger
    WHERE tgrelid = 'agent_revisions'::regclass AND tgname = 'agent_revisions_no_update_delete' AND tgenabled = 'O';
  IF NOT FOUND THEN RAISE EXCEPTION 'agent_revisions_no_update_delete trigger missing'; END IF;

  PERFORM 1 FROM pg_trigger
    WHERE tgrelid = 'prompt_versions'::regclass AND tgname = 'prompt_versions_no_update_delete' AND tgenabled = 'O';
  IF NOT FOUND THEN RAISE EXCEPTION 'prompt_versions_no_update_delete trigger missing'; END IF;

  PERFORM 1 FROM pg_trigger
    WHERE tgrelid = 'run_checkpoints'::regclass AND tgname = 'run_checkpoints_no_update_delete' AND tgenabled = 'O';
  IF NOT FOUND THEN RAISE EXCEPTION 'run_checkpoints_no_update_delete trigger missing'; END IF;

  -- Conversations/messages/runs/attempts must NOT carry the immutability trigger.
  PERFORM 1 FROM pg_trigger
    WHERE tgrelid IN ('conversations'::regclass, 'messages'::regclass,
                      'agent_runs'::regclass, 'run_attempts'::regclass)
      AND tgname IN ('agent_revisions_no_update_delete', 'prompt_versions_no_update_delete',
                     'run_checkpoints_no_update_delete');
  IF FOUND THEN RAISE EXCEPTION 'mutable conversation tables must not carry immutability triggers'; END IF;

  RAISE NOTICE 'conversation constraints verified';
END;
$$;
