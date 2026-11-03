-- Reconcile the two deployed 0024 histories without modifying their ledger rows.
BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
DECLARE
  schema_name text := current_schema();
  elapsed_complete boolean;
  elapsed_absent boolean;
  invited_complete boolean;
  invited_absent boolean;
  approval_complete boolean;
  pass integer;
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0026') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0024') OR
     NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0025') THEN
    RAISE EXCEPTION '0024 and 0025 must be applied before 0026';
  END IF;
  LOCK TABLE tasks, approvals, users, auth_accounts, installation_admin IN SHARE ROW EXCLUSIVE MODE;

  -- These sentinels prevent ambiguous branch selection and name collisions.
  -- The migration lifecycle additionally verifies complete catalog baselines.
  FOR pass IN 1..2 LOOP
    SELECT
      (SELECT count(*) = 2 FROM pg_attribute a
       WHERE a.attrelid = 'tasks'::regclass AND NOT a.attisdropped
         AND ((a.attname = 'time_basis' AND a.atttypid = 'jsonb'::regtype AND NOT a.attnotnull)
           OR (a.attname = 'display_version' AND a.atttypid = 'text'::regtype AND NOT a.attnotnull)))
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'tasks'::regclass AND attname = 'tzdb_version' AND atttypid = 'text'::regtype AND NOT attnotnull AND NOT attisdropped)
      AND (SELECT count(*) = 3 FROM pg_constraint WHERE conrelid = 'tasks'::regclass AND contype = 'c' AND convalidated AND conname IN ('tasks_time_basis_check','tasks_display_version_check','tasks_tzdb_version_check'))
      AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = schema_name AND p.proname = 'tasks_guard_elapsed_basis' AND p.pronargs = 0 AND p.prorettype = 'trigger'::regtype AND replace(p.prosrc, chr(13) || chr(10), chr(10)) = replace($elapsed_body$
  BEGIN
    IF TG_OP = 'UPDATE' AND OLD.time_basis IS NULL AND NEW.time_basis IS NOT NULL THEN
      RAISE EXCEPTION 'historical tasks cannot acquire elapsed provenance' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.time_basis IS NOT NULL AND
      (NEW.time_basis, NEW.display_version, NEW.fire_at_utc, NEW.wall_time, NEW.timezone_id,
       NEW.fold, NEW.resolved_utc_offset_seconds, NEW.tzdb_version, NEW.source_invocation_id, NEW.owner_id)
      IS DISTINCT FROM
      (OLD.time_basis, OLD.display_version, OLD.fire_at_utc, OLD.wall_time, OLD.timezone_id,
       OLD.fold, OLD.resolved_utc_offset_seconds, OLD.tzdb_version, OLD.source_invocation_id, OLD.owner_id) THEN
      RAISE EXCEPTION 'elapsed task frozen facts are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.time_basis IS NOT NULL THEN
      IF (NEW.time_basis->>'anchor_utc')::timestamptz
           + (NEW.time_basis->>'duration_seconds')::bigint * interval '1 second' <> NEW.fire_at_utc THEN
        RAISE EXCEPTION 'elapsed task arithmetic mismatch' USING ERRCODE = '23514', CONSTRAINT = 'tasks_time_basis_check';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM tool_invocations i JOIN messages m
          ON m.id::text = NEW.time_basis->>'source_message_id'
          AND m.owner_id = i.owner_id AND m.conversation_id = i.conversation_id AND m.role = 'user'
        WHERE i.invocation_id = NEW.source_invocation_id AND i.owner_id = NEW.owner_id
          AND i.tool_id = 'create_reminder'
      ) THEN
        RAISE EXCEPTION 'elapsed task source mismatch' USING ERRCODE = '23514', CONSTRAINT = 'tasks_time_basis_check';
      END IF;
      IF NEW.tzdb_version IS NULL AND NEW.wall_time <> to_char(NEW.fire_at_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') THEN
        RAISE EXCEPTION 'elapsed UTC display mismatch' USING ERRCODE = '23514', CONSTRAINT = 'tasks_tzdb_version_check';
      END IF;
    END IF;
    RETURN NEW;
  END;
  $elapsed_body$, chr(13) || chr(10), chr(10)))
      AND EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE t.tgrelid='tasks'::regclass AND t.tgname='tasks_elapsed_basis_guard' AND NOT t.tgisinternal AND t.tgtype=23 AND t.tgenabled='O' AND n.nspname=schema_name AND p.proname='tasks_guard_elapsed_basis')
      INTO elapsed_complete;

    SELECT NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='tasks'::regclass AND attname IN ('time_basis','display_version') AND NOT attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='tasks'::regclass AND attname='tzdb_version' AND atttypid='text'::regtype AND attnotnull AND NOT attisdropped)
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='tasks'::regclass AND conname IN ('tasks_time_basis_check','tasks_display_version_check','tasks_tzdb_version_check'))
      AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='tasks'::regclass AND tgname='tasks_elapsed_basis_guard' AND NOT tgisinternal)
      AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=schema_name AND p.proname='tasks_guard_elapsed_basis')
      INTO elapsed_absent;

    SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='approvals'::regclass AND attname='tzdb_version' AND atttypid='text'::regtype AND NOT attnotnull AND NOT attisdropped)
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='approvals'::regclass AND conname='approvals_tzdb_version_check' AND contype='c' AND convalidated)
      AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname=schema_name AND p.proname='approvals_guard_null_tzdb' AND p.pronargs=0 AND p.prorettype='trigger'::regtype AND replace(p.prosrc, chr(13) || chr(10), chr(10)) = replace($approval_body$
  BEGIN
    IF NEW.tzdb_version IS NULL AND NOT EXISTS (
      SELECT 1 FROM tasks t
      WHERE t.id = NEW.target_task_id AND t.owner_id = NEW.owner_id
        AND t.time_basis IS NOT NULL AND t.tzdb_version IS NULL
        AND t.fire_at_utc = NEW.fire_at_utc AND t.wall_time = NEW.wall_time
        AND t.timezone_id = NEW.timezone_id AND t.fold = NEW.fold
        AND t.resolved_utc_offset_seconds = NEW.resolved_utc_offset_seconds
    ) THEN
      RAISE EXCEPTION 'null tzdb cancellation must match its UTC elapsed task'
        USING ERRCODE = '23514', CONSTRAINT = 'approvals_tzdb_version_check';
    END IF;
    RETURN NEW;
  END;
  $approval_body$, chr(13) || chr(10), chr(10)))
      AND EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE t.tgrelid='approvals'::regclass AND t.tgname='approvals_null_tzdb_guard' AND NOT t.tgisinternal AND t.tgtype=23 AND t.tgenabled='O' AND n.nspname=schema_name AND p.proname='approvals_guard_null_tzdb')
      INTO approval_complete;

    SELECT (SELECT count(*) = 7 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=schema_name AND c.relkind='r' AND c.relname IN ('identity_invitations','identity_account_admissions','identity_contacts','identity_challenges','identity_mail_deliveries','identity_action_keys','identity_rate_limits'))
      AND (SELECT count(*) = 8 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_index i ON i.indexrelid=c.oid
           WHERE n.nspname=schema_name AND i.indisvalid AND i.indisready AND c.relname IN ('identity_invitations_pending_lookup_idx','identity_invitations_creator_created_idx','identity_invitations_state_expiry_idx','identity_challenges_user_purpose_generation_idx','identity_challenges_invitation_generation_idx','identity_challenges_expiry_idx','identity_mail_deliveries_status_created_idx','identity_rate_limits_expiry_idx'))
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='auth_accounts'::regclass AND conname='auth_accounts_user_id_key' AND contype='u' AND convalidated AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='auth_accounts'::regclass AND attname='user_id' AND NOT attisdropped)]::smallint[])
      INTO invited_complete;

    SELECT NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname=schema_name AND c.relname IN ('identity_invitations','identity_account_admissions','identity_contacts','identity_challenges','identity_mail_deliveries','identity_action_keys','identity_rate_limits','identity_invitations_pending_lookup_idx','identity_invitations_creator_created_idx','identity_invitations_state_expiry_idx','identity_challenges_user_purpose_generation_idx','identity_challenges_invitation_generation_idx','identity_challenges_expiry_idx','identity_mail_deliveries_status_created_idx','identity_rate_limits_expiry_idx'))
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='auth_accounts'::regclass AND conname='auth_accounts_user_id_key')
      INTO invited_absent;

    IF NOT approval_complete THEN
      RAISE EXCEPTION '0026 preflight: incomplete or altered 0025 approval structure';
    END IF;
    IF pass = 2 THEN
      IF NOT (elapsed_complete AND invited_complete) THEN
        RAISE EXCEPTION '0026 postflight: reconciliation structures incomplete';
      END IF;
    ELSIF invited_complete AND elapsed_absent THEN
      -- Main 0024: install the original elapsed 0024 DDL only.
  ALTER TABLE tasks
    ADD COLUMN time_basis jsonb NULL,
    ADD COLUMN display_version text NULL,
    ALTER COLUMN tzdb_version DROP NOT NULL,
    ADD CONSTRAINT tasks_time_basis_check CHECK (
      time_basis IS NULL OR (
        jsonb_typeof(time_basis) = 'object'
        AND time_basis ?& ARRAY['kind','anchor_utc','duration_seconds','source_message_id','revision']
        AND time_basis - ARRAY['kind','anchor_utc','duration_seconds','source_message_id','revision'] = '{}'::jsonb
        AND time_basis->>'kind' = 'elapsed'
        AND time_basis->>'revision' = 'elapsed/1'
        AND jsonb_typeof(time_basis->'anchor_utc') = 'string'
        AND time_basis->>'anchor_utc' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
        AND jsonb_typeof(time_basis->'source_message_id') = 'string'
        AND time_basis->>'source_message_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND jsonb_typeof(time_basis->'duration_seconds') = 'number'
        AND time_basis->>'duration_seconds' ~ '^[1-9][0-9]{0,11}$'
        AND source_invocation_id IS NOT NULL AND source_approval_id IS NULL
        AND display_version = 'elapsed/1'
        AND wall_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
      ) IS TRUE
    ),
    ADD CONSTRAINT tasks_display_version_check CHECK (
      (time_basis IS NULL AND display_version IS NULL)
      OR (time_basis IS NOT NULL AND display_version = 'elapsed/1')
    ),
    ADD CONSTRAINT tasks_tzdb_version_check CHECK (
      (tzdb_version IS NOT NULL AND (time_basis IS NULL OR length(tzdb_version) > 0))
      OR (tzdb_version IS NULL AND time_basis IS NOT NULL
          AND timezone_id = 'UTC' AND fold = 0 AND resolved_utc_offset_seconds = 0)
    );

  CREATE FUNCTION tasks_guard_elapsed_basis() RETURNS trigger LANGUAGE plpgsql AS $function$
  BEGIN
    IF TG_OP = 'UPDATE' AND OLD.time_basis IS NULL AND NEW.time_basis IS NOT NULL THEN
      RAISE EXCEPTION 'historical tasks cannot acquire elapsed provenance' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.time_basis IS NOT NULL AND
      (NEW.time_basis, NEW.display_version, NEW.fire_at_utc, NEW.wall_time, NEW.timezone_id,
       NEW.fold, NEW.resolved_utc_offset_seconds, NEW.tzdb_version, NEW.source_invocation_id, NEW.owner_id)
      IS DISTINCT FROM
      (OLD.time_basis, OLD.display_version, OLD.fire_at_utc, OLD.wall_time, OLD.timezone_id,
       OLD.fold, OLD.resolved_utc_offset_seconds, OLD.tzdb_version, OLD.source_invocation_id, OLD.owner_id) THEN
      RAISE EXCEPTION 'elapsed task frozen facts are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.time_basis IS NOT NULL THEN
      IF (NEW.time_basis->>'anchor_utc')::timestamptz
           + (NEW.time_basis->>'duration_seconds')::bigint * interval '1 second' <> NEW.fire_at_utc THEN
        RAISE EXCEPTION 'elapsed task arithmetic mismatch' USING ERRCODE = '23514', CONSTRAINT = 'tasks_time_basis_check';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM tool_invocations i JOIN messages m
          ON m.id::text = NEW.time_basis->>'source_message_id'
          AND m.owner_id = i.owner_id AND m.conversation_id = i.conversation_id AND m.role = 'user'
        WHERE i.invocation_id = NEW.source_invocation_id AND i.owner_id = NEW.owner_id
          AND i.tool_id = 'create_reminder'
      ) THEN
        RAISE EXCEPTION 'elapsed task source mismatch' USING ERRCODE = '23514', CONSTRAINT = 'tasks_time_basis_check';
      END IF;
      IF NEW.tzdb_version IS NULL AND NEW.wall_time <> to_char(NEW.fire_at_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') THEN
        RAISE EXCEPTION 'elapsed UTC display mismatch' USING ERRCODE = '23514', CONSTRAINT = 'tasks_tzdb_version_check';
      END IF;
    END IF;
    RETURN NEW;
  END;
  $function$;
  CREATE TRIGGER tasks_elapsed_basis_guard BEFORE INSERT OR UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION tasks_guard_elapsed_basis();

    ELSIF elapsed_complete AND invited_absent THEN
      -- Deployed elapsed 0024: install original invited 0024 preflight and DDL.
  -- Freeze identity writes before inspecting the original credential/binding facts.
  LOCK TABLE users, auth_accounts, installation_admin IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM auth_accounts GROUP BY user_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION '0024 preflight: duplicate credential user; inspect original rows, never delete or merge automatically';
  END IF;
  IF EXISTS (
    SELECT 1 FROM auth_accounts a LEFT JOIN users u ON u.id=a.user_id
    WHERE u.id IS NULL OR a.provider_id <> 'credential'
      OR (a.password_hash IS NOT NULL AND
        (a.password_hash !~ '^[0-9a-f]{32}:[0-9a-f]{128}$' OR a.account_id <> a.user_id::text))
      OR (a.password_hash IS NULL AND a.account_id NOT IN (a.user_id::text, 'seed:' || a.user_id::text))
  ) THEN
    RAISE EXCEPTION '0024 preflight: malformed credential identity; preserve original IDs and password hashes for explicit repair';
  END IF;
  IF EXISTS (
    SELECT 1 FROM installation_admin i
    LEFT JOIN users u ON u.id=i.user_id
    LEFT JOIN auth_accounts a ON a.user_id=i.user_id
    WHERE NOT i.singleton OR u.id IS NULL OR a.id IS NULL
      OR a.account_id <> i.user_id::text OR a.password_hash IS NULL OR a.password_hash = ''
  ) THEN
    RAISE EXCEPTION '0024 preflight: administrator binding lacks its original usable credential';
  END IF;

  ALTER TABLE auth_accounts ADD CONSTRAINT auth_accounts_user_id_key UNIQUE (user_id);

  CREATE TABLE identity_invitations (
    id uuid PRIMARY KEY,
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    lookup_digest bytea NOT NULL CHECK (octet_length(lookup_digest) = 32),
    lookup_key_id text NOT NULL,
    address_ciphertext bytea,
    address_nonce bytea,
    address_tag bytea,
    encryption_key_id text,
    masked_email text NOT NULL,
    state text NOT NULL CHECK (state IN ('pending','accepted','revoked','expired')),
    generation bigint NOT NULL CHECK (generation >= 1),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    accepted_user_id uuid UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    accepted_at timestamptz,
    revoked_at timestamptz,
    CONSTRAINT identity_invitations_expiry_check CHECK (expires_at > created_at),
    CONSTRAINT identity_invitations_address_check CHECK (
      (address_ciphertext IS NOT NULL AND address_nonce IS NOT NULL AND octet_length(address_nonce)=12
        AND address_tag IS NOT NULL AND octet_length(address_tag)=16 AND encryption_key_id IS NOT NULL)
      OR (state <> 'pending' AND address_ciphertext IS NULL AND address_nonce IS NULL
        AND address_tag IS NULL AND encryption_key_id IS NULL)
    ),
    CONSTRAINT identity_invitations_terminal_check CHECK (
      (state='accepted' AND accepted_user_id IS NOT NULL AND accepted_at IS NOT NULL AND revoked_at IS NULL)
      OR (state='revoked' AND accepted_user_id IS NULL AND accepted_at IS NULL AND revoked_at IS NOT NULL)
      OR (state IN ('pending','expired') AND accepted_user_id IS NULL AND accepted_at IS NULL AND revoked_at IS NULL)
    )
  );
  CREATE UNIQUE INDEX identity_invitations_pending_lookup_idx ON identity_invitations(lookup_digest) WHERE state='pending';
  CREATE INDEX identity_invitations_creator_created_idx ON identity_invitations(created_by,created_at DESC,id DESC);
  CREATE INDEX identity_invitations_state_expiry_idx ON identity_invitations(state,expires_at);

  CREATE TABLE identity_account_admissions (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
    source text NOT NULL CHECK (source IN ('installation_admin','invitation','local_maintenance')),
    invitation_id uuid UNIQUE REFERENCES identity_invitations(id) ON DELETE RESTRICT,
    admitted_at timestamptz NOT NULL,
    credential_revision bigint NOT NULL DEFAULT 1 CHECK (credential_revision >= 1),
    reset_generation bigint NOT NULL DEFAULT 0 CHECK (reset_generation >= 0),
    contact_generation bigint NOT NULL DEFAULT 0 CHECK (contact_generation >= 0),
    CONSTRAINT identity_account_admissions_source_binding_check CHECK (
      (source='invitation' AND invitation_id IS NOT NULL)
      OR (source IN ('installation_admin','local_maintenance') AND invitation_id IS NULL)
    )
  );

  CREATE TABLE identity_contacts (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    lookup_digest bytea NOT NULL UNIQUE CHECK (octet_length(lookup_digest)=32),
    lookup_key_id text NOT NULL,
    address_ciphertext bytea NOT NULL,
    address_nonce bytea NOT NULL CHECK (octet_length(address_nonce)=12),
    address_tag bytea NOT NULL CHECK (octet_length(address_tag)=16),
    encryption_key_id text NOT NULL,
    masked_email text NOT NULL,
    revision bigint NOT NULL CHECK (revision >= 1),
    verified_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  );

  CREATE TABLE identity_challenges (
    id uuid PRIMARY KEY,
    purpose text NOT NULL CHECK (purpose IN ('invitation','verify_contact','reset_password')),
    token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest)=32),
    token_key_id text NOT NULL,
    user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
    invitation_id uuid REFERENCES identity_invitations(id) ON DELETE RESTRICT,
    lookup_digest bytea NOT NULL CHECK (octet_length(lookup_digest)=32),
    lookup_key_id text NOT NULL,
    generation bigint NOT NULL CHECK (generation >= 1),
    contact_revision bigint CHECK (contact_revision >= 1),
    candidate_ciphertext bytea,
    candidate_nonce bytea,
    candidate_tag bytea,
    encryption_key_id text,
    masked_email text,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    revoked_at timestamptz,
    UNIQUE (purpose,invitation_id,generation),
    UNIQUE (purpose,user_id,generation),
    CONSTRAINT identity_challenges_expiry_check CHECK (expires_at > created_at),
    CONSTRAINT identity_challenges_binding_check CHECK (
      (purpose='invitation' AND invitation_id IS NOT NULL AND user_id IS NULL AND contact_revision IS NULL)
      OR (purpose='verify_contact' AND invitation_id IS NULL AND user_id IS NOT NULL AND contact_revision IS NULL)
      OR (purpose='reset_password' AND invitation_id IS NULL AND user_id IS NOT NULL AND contact_revision IS NOT NULL)
    ),
    CONSTRAINT identity_challenges_candidate_check CHECK (
      (purpose='verify_contact' AND masked_email IS NOT NULL AND
        ((candidate_ciphertext IS NOT NULL AND candidate_nonce IS NOT NULL AND octet_length(candidate_nonce)=12
          AND candidate_tag IS NOT NULL AND octet_length(candidate_tag)=16 AND encryption_key_id IS NOT NULL)
        OR (candidate_ciphertext IS NULL AND candidate_nonce IS NULL AND candidate_tag IS NULL AND encryption_key_id IS NULL)))
      OR (purpose<>'verify_contact' AND masked_email IS NULL AND candidate_ciphertext IS NULL
        AND candidate_nonce IS NULL AND candidate_tag IS NULL AND encryption_key_id IS NULL)
    )
  );
  CREATE INDEX identity_challenges_user_purpose_generation_idx ON identity_challenges(user_id,purpose,generation);
  CREATE INDEX identity_challenges_invitation_generation_idx ON identity_challenges(invitation_id,generation);
  CREATE INDEX identity_challenges_expiry_idx ON identity_challenges(expires_at);

  CREATE TABLE identity_mail_deliveries (
    id uuid PRIMARY KEY,
    challenge_id uuid NOT NULL UNIQUE REFERENCES identity_challenges(id) ON DELETE RESTRICT,
    generation bigint NOT NULL CHECK (generation >= 1),
    purpose text NOT NULL CHECK (purpose IN ('invitation','verify_contact','reset_password')),
    status text NOT NULL CHECK (status IN ('queued','submitting','submitted','failed','unknown','suppressed')),
    payload_ciphertext bytea,
    payload_nonce bytea,
    payload_tag bytea,
    encryption_key_id text,
    provider_request_id text,
    acceptance_id text,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    submitted_at timestamptz,
    finished_at timestamptz,
    payload_erased_at timestamptz,
    failure_code text,
    CONSTRAINT identity_mail_deliveries_payload_check CHECK (
      (payload_ciphertext IS NOT NULL AND payload_nonce IS NOT NULL AND octet_length(payload_nonce)=12
        AND payload_tag IS NOT NULL AND octet_length(payload_tag)=16 AND encryption_key_id IS NOT NULL)
      OR (payload_ciphertext IS NULL AND payload_nonce IS NULL AND payload_tag IS NULL AND encryption_key_id IS NULL)
    )
  );
  CREATE INDEX identity_mail_deliveries_status_created_idx ON identity_mail_deliveries(status,created_at,id);

  CREATE TABLE identity_action_keys (
    actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    action text NOT NULL CHECK (action IN ('invite_create','invite_resend')),
    key uuid NOT NULL,
    request_digest bytea NOT NULL CHECK (octet_length(request_digest)=32),
    request_key_id text NOT NULL,
    invitation_id uuid NOT NULL REFERENCES identity_invitations(id) ON DELETE RESTRICT,
    generation bigint NOT NULL CHECK (generation >= 1),
    delivery_id uuid NOT NULL REFERENCES identity_mail_deliveries(id) ON DELETE RESTRICT,
    response_snapshot jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    replay_until timestamptz NOT NULL,
    PRIMARY KEY (actor_id,action,key),
    CONSTRAINT identity_action_keys_replay_check CHECK (replay_until >= created_at + interval '7 days')
  );

  CREATE TABLE identity_rate_limits (
    action text NOT NULL CHECK (action IN ('sign_in','forgot','accept','reset','contact_request','contact_verify','invite_create','invite_resend','password_write')),
    dimension text NOT NULL CHECK (dimension IN ('identifier','address','ip','actor','token')),
    subject_digest bytea NOT NULL CHECK (octet_length(subject_digest)=32),
    subject_key_id text NOT NULL,
    window_started_at timestamptz NOT NULL,
    window_seconds integer NOT NULL CHECK (window_seconds > 0),
    count integer NOT NULL CHECK (count >= 0),
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (action,dimension,subject_digest,window_started_at,window_seconds),
    CONSTRAINT identity_rate_limits_expiry_check CHECK (expires_at > window_started_at)
  );
  CREATE INDEX identity_rate_limits_expiry_idx ON identity_rate_limits(expires_at);

  -- Only the explicit original administrator binding establishes admission.
  -- Disabled/deletion-requested status is retained; admission never activates a user.
  INSERT INTO identity_account_admissions(user_id,source,admitted_at)
    SELECT user_id,'installation_admin',created_at FROM installation_admin;
    ELSE
      RAISE EXCEPTION '0026 preflight: mixed, partial, or unknown 0024 structure';
    END IF;
  END LOOP;
  INSERT INTO schema_migrations(version) VALUES ('0026');
END;
$migration$;
COMMIT;
