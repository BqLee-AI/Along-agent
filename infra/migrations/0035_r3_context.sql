BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='0035') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='0034') THEN
    RAISE EXCEPTION '0034 must be applied before 0035';
  END IF;
  CREATE TABLE r3_context_freezes (
    run_id uuid PRIMARY KEY REFERENCES agent_runs(id) ON DELETE RESTRICT,
    owner_id uuid NOT NULL,
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
    input_message_id uuid NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    context jsonb NOT NULL CHECK (octet_length(context::text) <= 1048576),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TRIGGER r3_context_freezes_immutable BEFORE UPDATE OR DELETE ON r3_context_freezes
    FOR EACH ROW EXECUTE FUNCTION run_checkpoints_reject_mutation();
  INSERT INTO schema_migrations(version) VALUES ('0035');
END;
$migration$;
COMMIT;
