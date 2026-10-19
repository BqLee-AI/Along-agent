-- identity.test.sql: red/green contract tests for 0001 (issue #27).
-- Run against a throwaway database. Each RED block expects a specific
-- failure; unexpected success raises P0999. Wrap in a transaction that is
-- rolled back so the database is left clean.
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/identity.test.sql

BEGIN;

-- GREEN: user + session + account round trip
INSERT INTO users (id, display_name, auth_email, auth_provider, auth_subject)
VALUES ('6cf198da-3c9e-8917-130d-ec7073b7124c', 'green', 't1-green-handle@local.invalid', 'local', '6cf198da-3c9e-8917-130d-ec7073b7124c');

INSERT INTO sessions (id, user_id, token_hash, expires_at)
VALUES ('290260e2-a81e-708e-5b11-6cf7a6d043a3',
  '6cf198da-3c9e-8917-130d-ec7073b7124c', 'hash-t1-green-1', now() + interval '7 days');

INSERT INTO auth_accounts (user_id, provider_id, account_id, password_hash)
VALUES ('6cf198da-3c9e-8917-130d-ec7073b7124c', 'credential', 't1-green-handle', 'scrypt-green');

-- RED: duplicate auth_email
DO $$
BEGIN
  BEGIN
    INSERT INTO users (display_name, auth_email) VALUES ('dup', 't1-green-handle@local.invalid');
    RAISE EXCEPTION 'P0999: users auth_email duplicate unexpectedly succeeded';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'identity ok: auth_email duplicate rejected (%)', SQLSTATE;
  END;
END;
$$;

-- RED: duplicate token_hash
DO $$
BEGIN
  BEGIN
    INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES ('6cf198da-3c9e-8917-130d-ec7073b7124c', 'hash-t1-green-1', now() + interval '7 days');
    RAISE EXCEPTION 'P0999: sessions token_hash duplicate unexpectedly succeeded';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'identity ok: token_hash duplicate rejected (%)', SQLSTATE;
  END;
END;
$$;

-- RED: duplicate (provider_id, account_id)
DO $$
BEGIN
  BEGIN
    INSERT INTO auth_accounts (user_id, provider_id, account_id)
    VALUES ('6cf198da-3c9e-8917-130d-ec7073b7124c', 'credential', 't1-green-handle');
    RAISE EXCEPTION 'P0999: auth_accounts duplicate unexpectedly succeeded';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'identity ok: auth_accounts duplicate rejected (%)', SQLSTATE;
  END;
END;
$$;

-- RED: DELETE users rejected by trigger
DO $$
DECLARE
  msg text;
BEGIN
  BEGIN
    DELETE FROM users WHERE id = '6cf198da-3c9e-8917-130d-ec7073b7124c';
    RAISE EXCEPTION 'P0999: users DELETE unexpectedly succeeded';
  EXCEPTION
    WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
      -- The P0999 sentinel signals trigger loss; re-raise so it is not
      -- swallowed as a passing trigger rejection.
      IF msg LIKE 'P0999:%' THEN RAISE; END IF;
      RAISE NOTICE 'identity ok: users DELETE rejected (%)', SQLSTATE;
  END;
END;
$$;

-- RED: expires_at <= created_at rejected
DO $$
BEGIN
  BEGIN
    INSERT INTO sessions (user_id, token_hash, expires_at, created_at)
    VALUES ('6cf198da-3c9e-8917-130d-ec7073b7124c', 'hash-t1-green-2', now() - interval '1 hour', now());
    RAISE EXCEPTION 'P0999: sessions bad expiry unexpectedly succeeded';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'identity ok: bad expiry rejected (%)', SQLSTATE;
  END;
END;
$$;

ROLLBACK;
