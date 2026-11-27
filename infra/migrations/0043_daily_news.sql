BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT FROM schema_migrations WHERE version = '0043') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT FROM schema_migrations WHERE version = '0042') THEN
    RAISE EXCEPTION '0042 must be applied before 0043';
  END IF;

  CREATE TABLE news_wechat_bindings (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES users(id),
    platform_user_id text NOT NULL,
    credential_ciphertext text NOT NULL,
    revoked_at timestamptz,
    UNIQUE (owner_id, id)
  );
  CREATE UNIQUE INDEX news_wechat_active_owner_idx ON news_wechat_bindings(owner_id)
    WHERE revoked_at IS NULL;
  CREATE UNIQUE INDEX news_wechat_active_recipient_idx ON news_wechat_bindings(platform_user_id)
    WHERE revoked_at IS NULL;

  CREATE TABLE news_wechat_pairings (
    owner_id uuid PRIMARY KEY REFERENCES users(id),
    id uuid NOT NULL UNIQUE,
    secret_ciphertext text NOT NULL,
    expires_at timestamptz NOT NULL,
    poll_lease_id uuid,
    poll_lease_expires_at timestamptz
  );

  CREATE TABLE news_subscriptions (
    owner_id uuid PRIMARY KEY REFERENCES users(id),
    binding_id uuid,
    topics text[] NOT NULL,
    region text,
    enabled boolean NOT NULL,
    enabled_at timestamptz NOT NULL,
    FOREIGN KEY (owner_id, binding_id) REFERENCES news_wechat_bindings(owner_id, id),
    CHECK (NOT enabled OR binding_id IS NOT NULL)
  );

  CREATE TABLE news_editions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES news_subscriptions(owner_id),
    binding_id uuid NOT NULL,
    local_date date NOT NULL,
    timezone_id text NOT NULL,
    cutoff_at timestamptz NOT NULL,
    topics text[] NOT NULL,
    region text,
    claim_id uuid NOT NULL,
    lease_until timestamptz NOT NULL,
    coverage text CHECK (coverage IN ('complete', 'partial', 'failed')),
    items jsonb,
    UNIQUE (owner_id, local_date),
    UNIQUE (owner_id, id),
    FOREIGN KEY (owner_id, binding_id) REFERENCES news_wechat_bindings(owner_id, id),
    CHECK ((coverage IS NULL) = (items IS NULL))
  );

  CREATE TABLE news_deliveries (
    edition_id uuid PRIMARY KEY REFERENCES news_editions(id),
    status text NOT NULL CHECK (status IN ('sending', 'accepted', 'failed', 'unknown', 'skipped')),
    permitted_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );

  INSERT INTO schema_migrations (version) VALUES ('0043');
END;
$migration$;
COMMIT;
