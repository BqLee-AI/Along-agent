-- Stop legacy runtime writers before this cutover; new harness facts roll forward only.
BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0015') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0014') THEN
    RAISE EXCEPTION '0014 must be applied before 0015';
  END IF;

ALTER TABLE agent_runs
  ADD COLUMN execution text NOT NULL DEFAULT 'business',
  ADD COLUMN tools_allowlist jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN frozen_context jsonb NULL,
  ADD COLUMN input_message_id uuid NULL REFERENCES messages(id) ON DELETE RESTRICT,
  ADD COLUMN waiting_checkpoint_id uuid NULL REFERENCES run_checkpoints(id) ON DELETE RESTRICT,
  ADD COLUMN waiting_invocation_id uuid NULL,
  ADD COLUMN waiting_approval_id uuid NULL;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_execution_check CHECK (execution IN ('business','harness'));
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_harness_context_check CHECK (
  jsonb_typeof(tools_allowlist) = 'array' AND
  (execution = 'business' OR (mode = 'chat' AND input_message_id IS NOT NULL AND
    frozen_context IS NOT NULL AND jsonb_typeof(frozen_context) = 'object'))
);
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_waiting_check CHECK (
  (waiting_checkpoint_id IS NULL AND waiting_invocation_id IS NULL AND waiting_approval_id IS NULL
    AND (execution = 'business' OR status <> 'suspended_approval')) OR
  (execution = 'harness' AND status = 'suspended_approval' AND waiting_checkpoint_id IS NOT NULL
    AND waiting_invocation_id IS NOT NULL AND waiting_approval_id IS NOT NULL)
);
CREATE FUNCTION agent_runs_guard_frozen_runtime() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.execution,NEW.owner_id,NEW.conversation_id,NEW.agent_revision,NEW.mode,
      NEW.budget_max_iterations,NEW.budget_max_tokens,NEW.tools_allowlist,NEW.frozen_context,NEW.input_message_id)
    IS DISTINCT FROM
     (OLD.execution,OLD.owner_id,OLD.conversation_id,OLD.agent_revision,OLD.mode,
      OLD.budget_max_iterations,OLD.budget_max_tokens,OLD.tools_allowlist,OLD.frozen_context,OLD.input_message_id) THEN
    RAISE EXCEPTION 'Run execution and accepted authority are immutable';
  END IF;
  IF OLD.status IN ('done','failed','cancelled') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal Run is immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER agent_runs_frozen_runtime BEFORE UPDATE ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION agent_runs_guard_frozen_runtime();

ALTER TABLE run_checkpoints DROP CONSTRAINT run_checkpoints_kind_check;
ALTER TABLE run_checkpoints ADD CONSTRAINT run_checkpoints_kind_check CHECK (kind IN (
  'thinking','tool_call','tool_result','approval_required','answer',
  'thread.started','message.delta','card.proposed','thread.completed','thread.failed','thread.cancelled','harness_snapshot'
));
-- Defaults are evaluated before BEFORE INSERT triggers. Allocate the visible cursor
-- only after taking the conversation lock, held through the caller's COMMIT.
-- NO KEY UPDATE serializes writers without upgrading assistant-insert FK KEY SHARE.
CREATE FUNCTION run_checkpoints_serialize_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM conversations c JOIN agent_runs r ON r.conversation_id=c.id
    JOIN run_attempts a ON a.run_id=r.id WHERE a.id=NEW.attempt_id FOR NO KEY UPDATE OF c;
  NEW.event_seq := nextval('run_checkpoints_event_seq_seq');
  RETURN NEW;
END; $$;
CREATE TRIGGER run_checkpoints_cursor BEFORE INSERT ON run_checkpoints
  FOR EACH ROW EXECUTE FUNCTION run_checkpoints_serialize_cursor();

CREATE TABLE harness_resumes (
  owner_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  checkpoint_id uuid NOT NULL REFERENCES run_checkpoints(id) ON DELETE RESTRICT,
  attempt_id uuid NOT NULL REFERENCES run_attempts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,idempotency_key),
  UNIQUE(checkpoint_id),
  UNIQUE(attempt_id)
);
CREATE TRIGGER harness_resumes_no_update_delete BEFORE UPDATE OR DELETE ON harness_resumes
  FOR EACH ROW EXECUTE FUNCTION run_checkpoints_reject_mutation();
CREATE TABLE harness_cancellations (
  owner_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,idempotency_key)
);
CREATE TRIGGER harness_cancellations_no_update_delete BEFORE UPDATE OR DELETE ON harness_cancellations
  FOR EACH ROW EXECUTE FUNCTION run_checkpoints_reject_mutation();
INSERT INTO schema_migrations(version) VALUES ('0015');
END;
$migration$;
COMMIT;
