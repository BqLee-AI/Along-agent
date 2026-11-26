-- Run manually, with ON_ERROR_STOP, only on an isolated disposable database
-- named along_bot_cutover_<suffix> at 0041. Set along.bot_cutover_ids in this
-- session to the comma-separated UUIDs individually confirmed disposable.
-- See infra/migrations/README.md. This file is not a migration.
BEGIN;
SET LOCAL search_path = public, pg_catalog;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF current_database() !~ '^along_bot_cutover_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'cutover cleanup requires a disposable along_bot_cutover_<suffix> database';
  END IF;
  IF COALESCE(current_setting('along.bot_cutover_ids', true), '') = '' THEN
    RAISE EXCEPTION 'supply the individually confirmed disposable conversation IDs';
  END IF;
END;
$$;

LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $$
DECLARE relation regclass;
BEGIN
  IF (SELECT max(version) FROM schema_migrations) IS DISTINCT FROM '0041' THEN
    RAISE EXCEPTION 'disposable Bot cleanup only supports migration baseline 0041';
  END IF;
  -- The operator must stop old writers. Also keep the dependency check and
  -- deletion stable against other sessions, including writes to kept tables.
  FOR relation IN SELECT oid::regclass FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p') ORDER BY oid
  LOOP
    EXECUTE format('LOCK TABLE %s IN SHARE ROW EXCLUSIVE MODE', relation);
  END LOOP;
END;
$$;

CREATE TEMP TABLE cutover_conversations (id uuid PRIMARY KEY, owner_id uuid NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE cutover_ids (id uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO cutover_ids
SELECT btrim(value)::uuid FROM unnest(string_to_array(current_setting('along.bot_cutover_ids'), ',')) AS value;
INSERT INTO cutover_conversations SELECT c.id,c.owner_id FROM conversations c JOIN cutover_ids USING (id);
DO $$
BEGIN
  IF EXISTS (SELECT id FROM cutover_ids EXCEPT SELECT id FROM cutover_conversations) THEN
    RAISE EXCEPTION 'disposable Bot cleanup received an unknown conversation';
  END IF;
END;
$$;

CREATE TEMP VIEW cutover_runs AS
  SELECT r.* FROM agent_runs r JOIN cutover_conversations c ON (c.id,c.owner_id)=(r.conversation_id,r.owner_id);
CREATE TEMP VIEW cutover_attempts AS
  SELECT a.* FROM run_attempts a JOIN cutover_runs r ON (r.id,r.owner_id)=(a.run_id,a.owner_id);
CREATE TEMP VIEW cutover_invocations AS
  SELECT i.* FROM tool_invocations i JOIN cutover_runs r ON (r.id,r.owner_id,r.conversation_id)=(i.run_id,i.owner_id,i.conversation_id);
CREATE TEMP VIEW cutover_approvals AS
  SELECT a.* FROM approvals a JOIN cutover_conversations c ON (c.id,c.owner_id)=(a.conversation_id,a.owner_id);
CREATE TEMP VIEW cutover_document_approvals AS
  SELECT a.* FROM document_approvals a JOIN cutover_runs r ON (r.id,r.owner_id,r.conversation_id)=(a.run_id,a.owner_id,a.conversation_id);
CREATE TEMP VIEW cutover_pauses AS
  SELECT p.* FROM harness_pauses p JOIN cutover_runs r ON (r.id,r.owner_id,r.conversation_id)=(p.run_id,p.owner_id,p.conversation_id);
CREATE TEMP VIEW cutover_freezes AS
  SELECT f.* FROM compact_freezes f JOIN cutover_runs r ON (r.id,r.owner_id,r.conversation_id)=(f.run_id,f.owner_id,f.conversation_id);
CREATE TEMP VIEW cutover_summaries AS
  SELECT s.* FROM compact_summaries s JOIN cutover_freezes f ON (f.id,f.owner_id,f.conversation_id)=(s.freeze_id,s.owner_id,s.conversation_id);

DO $$
BEGIN
  IF EXISTS (SELECT FROM cutover_runs WHERE status NOT IN ('done','failed','cancelled'))
    OR EXISTS (SELECT FROM cutover_attempts WHERE status='running' OR ended_at IS NULL)
    OR EXISTS (SELECT FROM cutover_pauses WHERE state IN ('pending','paused'))
    OR EXISTS (
      SELECT FROM compact_operations
      WHERE pause_id IN (SELECT id FROM cutover_pauses) AND status IN ('pending','running')
    )
    OR EXISTS (SELECT FROM cutover_invocations WHERE state <> 'completed')
    OR EXISTS (SELECT FROM cutover_approvals WHERE state = 'pending')
    OR EXISTS (SELECT FROM cutover_document_approvals WHERE state = 'pending')
  THEN
    RAISE EXCEPTION 'settle live Runs, attempts, pending approvals and unsettled effects before cleanup';
  END IF;
  IF EXISTS (SELECT FROM cutover_approvals WHERE state = 'consumed' OR consumed_task_id IS NOT NULL) THEN
    RAISE EXCEPTION 'retained reminder effect refers to a disposable approval';
  END IF;
END;
$$;

-- Each ordered table slice names its own row-selection rule. Only the listed
-- immutability triggers may be suspended, transactionally, for these rows.
CREATE TEMP TABLE cutover_slices (
  step integer PRIMARY KEY, relation regclass NOT NULL, predicate text NOT NULL,
  identity_column text, immutable_trigger text
) ON COMMIT DROP;
INSERT INTO cutover_slices VALUES
  (1, 'compact_continuations', 'pause_id IN (SELECT id FROM cutover_pauses)', NULL, 'compact_continuations_immutable'),
  (2, 'compact_operations', 'pause_id IN (SELECT id FROM cutover_pauses)', NULL, NULL),
  (3, 'compact_heads', 'summary_id IN (SELECT id FROM cutover_summaries)', NULL, NULL),
  (4, 'compact_summary_sources', 'summary_id IN (SELECT id FROM cutover_summaries)', NULL, 'compact_summary_sources_immutable'),
  (5, 'compact_freeze_sources', 'freeze_id IN (SELECT id FROM cutover_freezes)', NULL, 'compact_freeze_sources_immutable'),
  (6, 'compact_summaries', 'id IN (SELECT id FROM cutover_summaries)', 'id', 'compact_summaries_immutable'),
  (7, 'compact_freezes', 'id IN (SELECT id FROM cutover_freezes)', 'id', 'compact_freezes_immutable'),
  (8, 'r3_context_freezes', 'run_id IN (SELECT id FROM cutover_runs)', NULL, 'r3_context_freezes_immutable'),
  (9, 'idle_compact_requests', '(conversation_id,owner_id) IN (SELECT id,owner_id FROM cutover_conversations)', NULL, 'idle_compact_requests_immutable'),
  (10, 'harness_pause_resumes', 'pause_id IN (SELECT id FROM cutover_pauses)', NULL, 'harness_pause_resumes_no_update_delete'),
  (11, 'harness_resumes', 'run_id IN (SELECT id FROM cutover_runs)', NULL, 'harness_resumes_no_update_delete'),
  (12, 'harness_pauses', 'id IN (SELECT id FROM cutover_pauses)', 'id', NULL),
  (13, 'harness_cancellations', 'run_id IN (SELECT id FROM cutover_runs)', NULL, 'harness_cancellations_no_update_delete'),
  (14, 'feishu_pending_disclosures', 'run_id IN (SELECT id FROM cutover_runs)', NULL, NULL),
  (15, 'model_provider_run_bindings', 'run_id IN (SELECT id FROM cutover_runs)', NULL, 'model_provider_binding_no_mutation'),
  (16, 'run_context_policies', 'run_id IN (SELECT id FROM cutover_runs)', NULL, 'run_context_policies_no_update_delete'),
  (17, 'conversation_idempotency', '(conversation_id,owner_id) IN (SELECT id,owner_id FROM cutover_conversations)', NULL, NULL),
  (18, 'tool_calls', 'run_id IN (SELECT id FROM cutover_runs)', 'id', 'tool_calls_no_update_delete'),
  (19, 'r3_memory_recall_receipts', 'invocation_id IN (SELECT invocation_id FROM cutover_invocations)', NULL, 'r3_memory_recall_receipt_no_mutation'),
  (20, 'document_approval_decisions', 'target_approval_id IN (SELECT id FROM cutover_document_approvals)', NULL, 'document_approval_decisions_append_only'),
  (21, 'document_approvals', 'id IN (SELECT id FROM cutover_document_approvals)', 'id', 'document_approvals_immutable'),
  (22, 'approval_revision_requests', 'target_approval_id IN (SELECT id FROM cutover_approvals) AND (successor_approval_id IS NULL OR successor_approval_id IN (SELECT id FROM cutover_approvals))', NULL, NULL),
  (23, 'tool_invocations', 'invocation_id IN (SELECT invocation_id FROM cutover_invocations)', 'invocation_id', 'tool_invocations_no_illegal_mutation'),
  (24, 'approvals', 'id IN (SELECT id FROM cutover_approvals)', 'id', NULL),
  (25, 'run_checkpoints', 'attempt_id IN (SELECT id FROM cutover_attempts)', 'id', 'run_checkpoints_no_update_delete'),
  (26, 'run_attempts', 'id IN (SELECT id FROM cutover_attempts)', 'id', NULL),
  (27, 'messages', '(conversation_id,owner_id) IN (SELECT id,owner_id FROM cutover_conversations) AND source_run_id IS NOT NULL', 'id', NULL),
  (28, 'agent_runs', 'id IN (SELECT id FROM cutover_runs)', 'id', NULL),
  (29, 'messages', '(conversation_id,owner_id) IN (SELECT id,owner_id FROM cutover_conversations) AND source_run_id IS NULL', 'id', NULL),
  (30, 'conversations', 'id IN (SELECT id FROM cutover_conversations)', 'id', NULL);

CREATE TEMP TABLE cutover_rows (
  step integer, relation regclass, location tid, id uuid, PRIMARY KEY (relation, location)
) ON COMMIT DROP;
CREATE INDEX ON cutover_rows (id);
DO $$
DECLARE slice cutover_slices%ROWTYPE;
BEGIN
  FOR slice IN SELECT * FROM cutover_slices ORDER BY step LOOP
    EXECUTE format('INSERT INTO cutover_rows SELECT %s, %L::regclass, ctid, %s FROM %s WHERE %s',
      slice.step, slice.relation,
      CASE WHEN slice.identity_column IS NULL THEN 'NULL' ELSE quote_ident(slice.identity_column) END,
      slice.relation, slice.predicate);
  END LOOP;
END;
$$;

DO $$
DECLARE relation regclass;
DECLARE blocked uuid;
BEGIN
  -- FKs stay enabled. Refuse undeclared cascading or nulling actions rather
  -- than trusting every referencing table to have been in the reviewed copy.
  IF EXISTS (SELECT FROM pg_constraint
    WHERE contype='f' AND confrelid IN (SELECT s.relation FROM cutover_slices s)
      AND confdeltype NOT IN ('a','r')) THEN
    RAISE EXCEPTION 'cutover dependency guard found an unsafe foreign-key delete action';
  END IF;
  IF EXISTS (
    SELECT FROM cutover_slices slice
    WHERE slice.immutable_trigger IS NOT NULL AND NOT EXISTS (
      SELECT FROM pg_trigger history_trigger
      WHERE history_trigger.tgrelid=slice.relation AND history_trigger.tgname=slice.immutable_trigger
        AND history_trigger.tgenabled='O' AND NOT history_trigger.tgisinternal
    )
  ) THEN
    RAISE EXCEPTION 'cutover dependency guard found a missing or altered history trigger';
  END IF;

  -- Some provenance references are logical (including UUID arrays and IDs
  -- embedded in JSON receipts). Treat apparent references conservatively.
  FOR relation IN SELECT oid::regclass FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') ORDER BY oid
  LOOP
    EXECUTE format($scan$
      SELECT selected.id FROM ONLY %s kept
      CROSS JOIN LATERAL regexp_matches(to_jsonb(kept)::text,
        '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'gi') AS ref(parts)
      JOIN cutover_rows selected ON selected.id=ref.parts[1]::uuid
      WHERE NOT EXISTS (SELECT FROM cutover_rows deleting WHERE deleting.relation=$1 AND deleting.location=kept.ctid)
      LIMIT 1
    $scan$, relation) INTO blocked USING relation;
    IF blocked IS NOT NULL THEN
      RAISE EXCEPTION 'cutover dependency guard: retained table % references disposable ID %', relation, blocked;
    END IF;
  END LOOP;
END;
$$;

-- Break only the compact freeze/summary FK cycle, and only on staged rows.
ALTER TABLE compact_freezes DISABLE TRIGGER compact_freezes_immutable;
WITH moved AS (
  UPDATE compact_freezes f SET previous_summary_id=NULL
  FROM cutover_rows s WHERE s.step=7 AND s.location=f.ctid AND f.previous_summary_id IS NOT NULL
  RETURNING f.id,f.ctid
)
UPDATE cutover_rows s SET location=moved.ctid FROM moved WHERE s.step=7 AND s.id=moved.id;
ALTER TABLE compact_freezes ENABLE TRIGGER compact_freezes_immutable;

DO $$
DECLARE slice cutover_slices%ROWTYPE;
DECLARE removed bigint;
BEGIN
  FOR slice IN SELECT * FROM cutover_slices ORDER BY step LOOP
    IF NOT EXISTS (SELECT FROM cutover_rows WHERE step=slice.step) THEN CONTINUE; END IF;
    IF slice.immutable_trigger IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', slice.relation, slice.immutable_trigger);
    END IF;
    EXECUTE format('DELETE FROM ONLY %s t USING cutover_rows s WHERE s.step=$1 AND s.location=t.ctid', slice.relation)
      USING slice.step;
    GET DIAGNOSTICS removed = ROW_COUNT;
    IF removed <> (SELECT count(*) FROM cutover_rows WHERE step=slice.step) THEN
      RAISE EXCEPTION 'unexpected cleanup row count for %', slice.relation;
    END IF;
    IF slice.immutable_trigger IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %s ENABLE TRIGGER %I', slice.relation, slice.immutable_trigger);
    END IF;
  END LOOP;
END;
$$;

DROP VIEW cutover_summaries, cutover_freezes, cutover_pauses, cutover_document_approvals,
  cutover_approvals, cutover_invocations, cutover_attempts, cutover_runs;
COMMIT;
