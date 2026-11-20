BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0039') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0038') THEN
    RAISE EXCEPTION '0038 must be applied before 0039';
  END IF;

CREATE TABLE feishu_docx_connections (
  owner_id uuid PRIMARY KEY REFERENCES users (id),
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  id uuid NOT NULL UNIQUE,
  app_id text NOT NULL,
  redirect_uri text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('authorizing', 'exchanging', 'pending', 'active')),
  expires_at timestamptz NOT NULL,
  token_expires_at timestamptz,
  state_digest text,
  secret_box text,
  open_id text,
  tenant_key text,
  display_name text
);

CREATE UNIQUE INDEX feishu_docx_connections_subject_unique
  ON feishu_docx_connections (app_id, tenant_key, open_id) WHERE phase = 'active';

INSERT INTO schema_migrations(version) VALUES ('0039');
END;
$migration$;
COMMIT;
