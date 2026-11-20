BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0040') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0039') THEN
    RAISE EXCEPTION '0039 must be applied before 0040';
  END IF;

CREATE TABLE feishu_bot_connections (
  owner_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  session_id uuid REFERENCES sessions (id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  app_id text UNIQUE,
  bot_name text,
  CHECK ((app_id IS NULL AND bot_name IS NULL AND session_id IS NOT NULL)
      OR (app_id IS NOT NULL AND bot_name IS NOT NULL AND session_id IS NULL))
);

INSERT INTO schema_migrations(version) VALUES ('0040');
END;
$migration$;
COMMIT;
