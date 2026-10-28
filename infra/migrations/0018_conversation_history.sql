-- Add only owner-scoped keyset indexes; preserve all existing tables and facts.
BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0018') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0017') THEN
    RAISE EXCEPTION '0017 must be applied before 0018';
  END IF;

  CREATE INDEX conversations_owner_history_idx
    ON conversations (owner_id, created_at DESC, id DESC);
  CREATE INDEX messages_owner_conversation_history_idx
    ON messages (owner_id, conversation_id, created_at, id)
    WHERE role IN ('user', 'assistant');
  CREATE INDEX agent_runs_owner_conversation_history_idx
    ON agent_runs (owner_id, conversation_id, created_at, id);

  INSERT INTO schema_migrations(version) VALUES ('0018');
END;
$migration$;
COMMIT;
