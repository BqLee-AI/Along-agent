-- verify-identity.sql: structural assertions for 0001 (issue #27).
-- Run on a fresh DB after apply. Raises NOTICE 'identity constraints verified'.
\set ON_ERROR_STOP on

DO $$
DECLARE
  def text;
BEGIN
  -- users PK + unique columns
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
    WHERE conrelid = 'users'::regclass AND contype = 'p' AND conname = 'users_pkey';
  IF def IS NULL THEN RAISE EXCEPTION 'users pkey missing'; END IF;

  -- unique(auth_email): not-null unique
  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'users'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (auth_email)';
  IF NOT FOUND THEN RAISE EXCEPTION 'users auth_email unique missing'; END IF;

  -- partial unique (auth_provider, auth_subject): index predicate check
  PERFORM 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'users'::regclass
      AND pg_get_indexdef(i.indexrelid) LIKE '%(auth_provider, auth_subject)%'
      AND pg_get_expr(i.indpred, i.indrelid) LIKE '%auth_provider IS NOT NULL%';
  IF NOT FOUND THEN RAISE EXCEPTION 'users auth subject partial unique missing'; END IF;

  -- users_no_delete trigger present and enabled
  PERFORM 1 FROM pg_trigger
    WHERE tgrelid = 'users'::regclass AND tgname = 'users_no_delete' AND tgenabled = 'O';
  IF NOT FOUND THEN RAISE EXCEPTION 'users_no_delete trigger missing'; END IF;

  -- sessions FK to users, token_hash unique, no raw token column
  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'sessions'::regclass AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE '%REFERENCES users(id)%';
  IF NOT FOUND THEN RAISE EXCEPTION 'sessions user FK missing'; END IF;

  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'sessions'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (token_hash)';
  IF NOT FOUND THEN RAISE EXCEPTION 'sessions token_hash unique missing'; END IF;

  PERFORM 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name IN ('token', 'token_plaintext', 'raw_token');
  IF FOUND THEN RAISE EXCEPTION 'sessions must not store plaintext token'; END IF;

  -- auth_accounts unique(provider_id, account_id)
  PERFORM 1 FROM pg_constraint
    WHERE conrelid = 'auth_accounts'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (provider_id, account_id)';
  IF NOT FOUND THEN RAISE EXCEPTION 'auth_accounts unique missing'; END IF;

  -- business tables keep logical owner_id: no FK to users
  PERFORM 1 FROM pg_constraint
    WHERE conrelid IN ('approvals'::regclass, 'tasks'::regclass, 'task_events'::regclass)
      AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE '%REFERENCES users%';
  IF FOUND THEN RAISE EXCEPTION 'business tables must not FK to users'; END IF;

  RAISE NOTICE 'identity constraints verified';
END;
$$;
