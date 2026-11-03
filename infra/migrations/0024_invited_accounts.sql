BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0024') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0023') THEN
    RAISE EXCEPTION '0023 must be applied before 0024';
  END IF;
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
  INSERT INTO schema_migrations(version) VALUES ('0024');
END;
$migration$;
COMMIT;
