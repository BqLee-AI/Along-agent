-- 0011 conversation agent support: ToolGateway audit + SSE replay backbone (#9).
-- Spec: docs/schema/conversation-and-runs-schema.md (tool_calls section),
-- docs/api/conversations/conversations_routes.md (idempotency §).
-- Group: conversation (range updated to [2,11] in scripts/check-migrations.mjs).
--
-- (a) conversation_idempotency: inbound Idempotency-Key binding. One row per
--     (owner, key); the first writer wins (concurrent retries serialize on
--     the PK). request_hash binds the replay guard to an identical POST body
--     (mismatched bodies return 409, never overwrite). expires_at is the
--     24h replay window; an index supports sweeps. Rows are NOT immutable:
--     expiry cleanup deletes them (only tool_calls / run_checkpoints are
--     append-only here).
-- (b) tool_calls: per-invocation audit rows written by ToolGateway.invokeTool.
--     Append-only: BEFORE UPDATE OR DELETE trigger raises P0001, same shape
--     as 0002/0005. decision is the gateway verdict ('allow' | 'deny');
--     approval_id is NULL for denied/failed invocations.
-- (c) run_checkpoints: widen the closed kind set with the six new frozen SSE
--     thread words (packages/stream-protocol THREAD_EVENT_TYPES v1:
--     thread.started, message.delta, card.proposed, approval_required,
--     thread.completed, thread.failed, thread.cancelled; 'approval_required'
--     already exists in the 0002 closed set so it is kept, not duplicated).
--     Add event_seq, the global append-only stream id backing
--     GET .../events?after_seq cursors. event_seq is bigint + sequence (NOT
--     per-conversation 1..N: sparse across conversations; clients use opaque
--     after_seq cursors, never arithmetic).
-- (d) approvals: kind ('create_task' | 'cancel_task', default keeps pre-0011
--     rows as create_task) + target_task_id + expected_state_version for the
--     cancel-confirm branch; CHECK pins create<->NULL / cancel<->NOT NULL pairs.
--
-- Forbidden: no LLM/provider columns, no cards table, no tasks/outbox
-- writes. No migration may run UPDATE task_events / DELETE FROM task_events
-- (check-migrations.mjs append-only scan).

BEGIN;

-- (a) Idempotency ledger.
CREATE TABLE conversation_idempotency (
  owner_id uuid NOT NULL REFERENCES users (id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE RESTRICT,
  run_id uuid NOT NULL REFERENCES agent_runs (id) ON DELETE RESTRICT,
  user_message_id uuid NULL REFERENCES messages (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT conversation_idempotency_pkey PRIMARY KEY (owner_id, idempotency_key)
);

CREATE INDEX conversation_idempotency_expires_at_idx ON conversation_idempotency (expires_at);

-- (b) Tool-call audit ledger (append-only).
CREATE TABLE tool_calls (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users (id),
  run_id uuid NOT NULL REFERENCES agent_runs (id) ON DELETE RESTRICT,
  attempt_id uuid NULL REFERENCES run_attempts (id) ON DELETE RESTRICT,
  tool_id text NOT NULL,
  args_hash text NOT NULL,
  decision text NOT NULL,
  approval_id uuid NULL REFERENCES approvals (id) ON DELETE RESTRICT,
  error_code text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tool_calls_decision_check CHECK (decision IN ('allow', 'deny')),
  CONSTRAINT tool_calls_invocation_uniq UNIQUE (run_id, tool_id, args_hash)
);

CREATE INDEX tool_calls_run_created_idx ON tool_calls (run_id, created_at);

CREATE OR REPLACE FUNCTION tool_calls_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'tool_calls is append-only';
END;
$$;

CREATE TRIGGER tool_calls_no_update_delete
  BEFORE UPDATE OR DELETE ON tool_calls
  FOR EACH ROW
  EXECUTE FUNCTION tool_calls_reject_mutation();

-- (c) Checkpoint ledger: widen kinds + global stream id.
ALTER TABLE run_checkpoints
  DROP CONSTRAINT run_checkpoints_kind_check;

ALTER TABLE run_checkpoints
  ADD CONSTRAINT run_checkpoints_kind_check CHECK (kind IN (
    'thinking', 'tool_call', 'tool_result', 'approval_required', 'answer',
    'thread.started', 'message.delta', 'card.proposed',
    'thread.completed', 'thread.failed', 'thread.cancelled'
  ));

CREATE SEQUENCE run_checkpoints_event_seq_seq AS bigint;

ALTER TABLE run_checkpoints
  ADD COLUMN event_seq bigint NOT NULL DEFAULT nextval('run_checkpoints_event_seq_seq');

ALTER SEQUENCE run_checkpoints_event_seq_seq OWNED BY run_checkpoints.event_seq;

CREATE UNIQUE INDEX run_checkpoints_event_seq_uniq ON run_checkpoints (event_seq);

CREATE INDEX run_checkpoints_attempt_event_seq_idx ON run_checkpoints (attempt_id, event_seq);

-- (d) Approval kinds: distinguish create_task from cancel_task without a new
--     table. 0003 approvals predate #9 and carry no kind; every pre-0011 row
--     is a create_task. target_task_id is the cancel target (NULL for
--     create_task; create_task rows keep the created task in
--     consumed_task_id instead, so cancel leaves consumed_task_id NULL and the
--     approvals_consumed_task_id_uniq NULL semantics are untouched).
--     expected_state_version records the task version the cancel proposal
--     was validated against (audit only; confirm guards on live task state so
--     a scheduler bump between proposal and confirm does not false-409).
ALTER TABLE approvals
  ADD COLUMN kind text NOT NULL DEFAULT 'create_task',
  ADD COLUMN target_task_id uuid NULL REFERENCES tasks (id) ON DELETE RESTRICT,
  ADD COLUMN expected_state_version integer NULL;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_kind_check CHECK (kind IN ('create_task', 'cancel_task'));

ALTER TABLE approvals
  ADD CONSTRAINT approvals_cancel_target_check CHECK (
    (kind = 'create_task' AND target_task_id IS NULL AND expected_state_version IS NULL)
    OR (kind = 'cancel_task' AND target_task_id IS NOT NULL AND expected_state_version IS NOT NULL)
  );

CREATE INDEX approvals_owner_kind_idx ON approvals (owner_id, kind);

COMMIT;
