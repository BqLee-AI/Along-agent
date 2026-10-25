-- Stop all legacy tool writers before this transactional cutover. Once new
-- invocations are accepted, recover by rolling forward, never by old writers.
BEGIN;

LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0014') THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0013') THEN
    RAISE EXCEPTION '0013 must be applied before 0014';
  END IF;
  LOCK TABLE tool_calls IN ACCESS EXCLUSIVE MODE;

CREATE TABLE tool_invocations (
  invocation_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  run_id uuid NOT NULL,
  call_key text NOT NULL CHECK (length(call_key) BETWEEN 1 AND 200),
  first_attempt_id uuid NOT NULL,
  first_request_id text NOT NULL,
  tool_id text NOT NULL,
  args_hash text NOT NULL CHECK (args_hash ~ '^[0-9a-f]{64}$'),
  args_bytes integer NOT NULL CHECK (args_bytes >= 0),
  execution_kind text NOT NULL CHECK (execution_kind IN ('local','read_only','non_transactional')),
  frozen_context jsonb NOT NULL CHECK (jsonb_typeof(frozen_context) = 'object'),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','unknown','completed')),
  outcome_kind text NULL CHECK (outcome_kind IN ('success','approval_pending','clarification','time_error','denied','failed')),
  result_version integer NULL,
  accepted_result jsonb NULL,
  approval_id uuid NULL,
  accepted_attempt_id uuid NULL,
  accepted_request_id text NULL,
  accepted_at timestamptz NULL,
  evidence_ref text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tool_invocations_run_slot_uniq UNIQUE (run_id, call_key),
  CONSTRAINT tool_invocations_result_check CHECK (
    (state IN ('reserved','unknown') AND outcome_kind IS NULL AND result_version IS NULL
      AND accepted_result IS NULL AND approval_id IS NULL AND accepted_attempt_id IS NULL
      AND accepted_request_id IS NULL AND accepted_at IS NULL AND evidence_ref IS NULL)
    OR (state = 'completed' AND outcome_kind IS NOT NULL AND result_version = 1
      AND accepted_result IS NOT NULL AND jsonb_typeof(accepted_result) = 'object'
      AND octet_length(accepted_result::text) <= 262144
      AND accepted_attempt_id IS NOT NULL AND accepted_request_id IS NOT NULL AND accepted_at IS NOT NULL
      AND ((outcome_kind = 'approval_pending' AND approval_id IS NOT NULL)
        OR (outcome_kind <> 'approval_pending' AND approval_id IS NULL)))
  ),
  CONSTRAINT tool_invocations_unknown_check CHECK (state <> 'unknown' OR execution_kind = 'non_transactional')
);
CREATE INDEX tool_invocations_owner_run_created_idx ON tool_invocations (owner_id, run_id, created_at);

CREATE FUNCTION tool_invocations_guard_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tool_invocations cannot be deleted';
  END IF;
  IF OLD.state = 'completed' THEN
    RAISE EXCEPTION 'completed tool invocation is immutable';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['state','outcome_kind','result_version','accepted_result','approval_id',
      'accepted_attempt_id','accepted_request_id','accepted_at','evidence_ref']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['state','outcome_kind','result_version','accepted_result','approval_id',
      'accepted_attempt_id','accepted_request_id','accepted_at','evidence_ref']) THEN
    RAISE EXCEPTION 'tool invocation identity and context are immutable';
  END IF;
  IF NOT ((OLD.state = 'reserved' AND NEW.state = 'completed'
            AND (OLD.execution_kind <> 'non_transactional' OR NEW.outcome_kind = 'denied'))
       OR (OLD.state = 'reserved' AND NEW.state = 'unknown' AND OLD.execution_kind = 'non_transactional')
       OR (OLD.state = 'unknown' AND NEW.state = 'completed')) THEN
    RAISE EXCEPTION 'illegal tool invocation state transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tool_invocations_no_illegal_mutation BEFORE UPDATE OR DELETE ON tool_invocations
  FOR EACH ROW EXECUTE FUNCTION tool_invocations_guard_mutation();

ALTER TABLE tool_calls DROP CONSTRAINT tool_calls_invocation_uniq;
ALTER TABLE tool_calls
  ADD COLUMN invocation_id uuid NULL REFERENCES tool_invocations (invocation_id) ON DELETE RESTRICT,
  ADD COLUMN request_id text NULL,
  ADD COLUMN record_kind text NOT NULL DEFAULT 'legacy',
  ADD COLUMN outcome_kind text NULL;
ALTER TABLE tool_calls ADD CONSTRAINT tool_calls_record_kind_check CHECK (
  (record_kind = 'legacy' AND invocation_id IS NULL AND request_id IS NULL)
  OR (record_kind IN ('accepted','replayed','denied','failed','dispatch','unknown','reconciled')
    AND invocation_id IS NOT NULL AND request_id IS NOT NULL)
);
ALTER TABLE tool_calls ADD CONSTRAINT tool_calls_outcome_kind_check CHECK (
  outcome_kind IS NULL OR outcome_kind IN ('success','approval_pending','clarification','time_error','denied','failed','unknown')
);
CREATE INDEX tool_calls_invocation_created_idx ON tool_calls (invocation_id, created_at);
INSERT INTO schema_migrations (version) VALUES ('0014');
END;
$migration$;
COMMIT;
