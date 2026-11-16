BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0037') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0036') THEN
    RAISE EXCEPTION '0036 must be applied before 0037';
  END IF;

  ALTER TABLE model_provider_models ADD COLUMN context_window_tokens bigint
    CHECK (context_window_tokens > 0 AND context_window_tokens <= 9007199254740991::bigint);
  ALTER TABLE model_provider_run_bindings ADD COLUMN context_window_tokens bigint
    CHECK (context_window_tokens > 0 AND context_window_tokens <= 9007199254740991::bigint);
  INSERT INTO schema_migrations(version) VALUES ('0037');
END;
$migration$;
COMMIT;
