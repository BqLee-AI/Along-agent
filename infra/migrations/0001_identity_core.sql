-- 0001 identity core: users/sessions/auth_accounts for Better Auth
-- self-hosted credential (issue #27, decision #1).
-- Spec: docs/schema/identity-schema.md (users/sessions sections).
-- auth_accounts is a Better Auth support table (credential store); the
-- Deferred wording in identity-schema is updated in the same PR.
-- owner_id in business tables stays a logical reference: no FK to users.
-- Numbers: 0001 identity, 0002 conversation/runs, 0003+ commitments.

BEGIN;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL DEFAULT '',
  primary_email_hash text NULL,
  auth_subject text NULL,
  auth_provider text NULL,
  timezone_id text NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}',
  auth_email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  CONSTRAINT users_auth_provider_check CHECK (auth_provider IS NULL OR auth_provider = 'local'),
  CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled', 'deleted_requested'))
);

CREATE UNIQUE INDEX users_auth_subject_uniq
  ON users (auth_provider, auth_subject)
  WHERE auth_provider IS NOT NULL AND auth_subject IS NOT NULL;
CREATE INDEX users_status_idx ON users (status);
CREATE INDEX users_created_at_idx ON users (created_at DESC);

-- No physical delete of users:注销走 status 标记 (identity-schema 写入规则).
CREATE OR REPLACE FUNCTION users_reject_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'users is delete-protected; mark status instead';
END;
$$;

CREATE TRIGGER users_no_delete
  BEFORE DELETE ON users
  FOR EACH ROW
  EXECUTE FUNCTION users_reject_delete();

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  last_seen_at timestamptz NULL,
  client_info jsonb NOT NULL DEFAULT '{}',
  CONSTRAINT sessions_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX sessions_user_created_idx ON sessions (user_id, created_at DESC);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE auth_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  provider_id text NOT NULL DEFAULT 'credential',
  account_id text NOT NULL,
  password_hash text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_accounts_provider_check CHECK (provider_id = 'credential'),
  CONSTRAINT auth_accounts_account_uniq UNIQUE (provider_id, account_id)
);

CREATE INDEX auth_accounts_user_idx ON auth_accounts (user_id);

COMMIT;
