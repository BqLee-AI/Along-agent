-- Preserve server-owned evidence of cancellation candidates actually presented.
-- Historical Runs remain untouched and do not acquire continuation authority.
BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0027') THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0026') THEN
    RAISE EXCEPTION '0026 must be applied before 0027';
  END IF;

  ALTER TABLE agent_runs ADD COLUMN cancellation_scope_candidates jsonb;
  INSERT INTO schema_migrations(version) VALUES ('0027');
END;
$migration$;
COMMIT;
