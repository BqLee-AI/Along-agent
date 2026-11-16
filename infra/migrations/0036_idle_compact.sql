BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='0036') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='0035') THEN
    RAISE EXCEPTION '0035 must be applied before 0036';
  END IF;
  ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_harness_context_check;
  ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_harness_context_check CHECK (
    jsonb_typeof(tools_allowlist) = 'array' AND
    (execution = 'business' OR (mode = 'chat' AND
      frozen_context IS NOT NULL AND jsonb_typeof(frozen_context) = 'object' AND
      (input_message_id IS NOT NULL OR COALESCE(
        frozen_context->>'execution_profile' = 'compact-memory/1' AND
        frozen_context->>'execution_lifecycle' = 'server-owned', false
      ))))
  );
  ALTER TABLE r3_context_freezes ALTER COLUMN input_message_id DROP NOT NULL;
  ALTER TABLE r3_context_freezes ADD CONSTRAINT r3_context_freezes_input_kind_check CHECK (COALESCE(
    (input_message_id IS NULL AND context->'input' = '{"type":"compact_control"}'::jsonb)
    OR (input_message_id IS NOT NULL AND context->'input'->>'type' = 'user'
        AND context->'input'->>'message_id' = input_message_id::text), false
  ));
  CREATE TABLE idle_compact_requests (
    owner_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
    run_id uuid REFERENCES agent_runs(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, idempotency_key),
    UNIQUE (run_id)
  );
  CREATE TRIGGER idle_compact_requests_immutable BEFORE UPDATE OR DELETE ON idle_compact_requests
    FOR EACH ROW EXECUTE FUNCTION run_checkpoints_reject_mutation();
  INSERT INTO schema_migrations(version) VALUES ('0036');
END;
$migration$;
COMMIT;
