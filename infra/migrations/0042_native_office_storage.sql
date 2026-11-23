BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0042') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0041') THEN
    RAISE EXCEPTION '0041 must be applied before 0042';
  END IF;

-- Additional FK targets only: old rows and their authorization are unchanged.
ALTER TABLE conversations ADD CONSTRAINT conversations_id_owner_unique UNIQUE (id, owner_id);
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_id_owner_conversation_unique
  UNIQUE (id, owner_id, conversation_id);

-- A continuation references the original frozen material scope, not the draft.
CREATE TABLE office_run_materials (
  run_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  session_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  scope_run_id uuid NOT NULL,
  previous_run_id uuid UNIQUE,
  delivery_run_id uuid UNIQUE,
  delivery_params_sha256 text CHECK (delivery_params_sha256 ~ '^[0-9a-f]{64}$'),
  UNIQUE (run_id, owner_id, conversation_id),
  UNIQUE (run_id, owner_id, conversation_id, session_id, draft_id),
  UNIQUE (run_id, owner_id, conversation_id, scope_run_id, draft_id),
  UNIQUE (run_id, owner_id, conversation_id, scope_run_id),
  FOREIGN KEY (conversation_id, owner_id) REFERENCES conversations (id, owner_id),
  FOREIGN KEY (run_id, owner_id, conversation_id) REFERENCES agent_runs (id, owner_id, conversation_id),
  FOREIGN KEY (scope_run_id, owner_id, conversation_id)
    REFERENCES office_run_materials (run_id, owner_id, conversation_id),
  FOREIGN KEY (previous_run_id, owner_id, conversation_id, scope_run_id, draft_id)
    REFERENCES office_run_materials (run_id, owner_id, conversation_id, scope_run_id, draft_id),
  FOREIGN KEY (delivery_run_id, owner_id, conversation_id, scope_run_id)
    REFERENCES office_run_materials (run_id, owner_id, conversation_id, scope_run_id),
  CHECK ((scope_run_id = run_id AND previous_run_id IS NULL)
    OR (scope_run_id <> run_id AND previous_run_id <> run_id AND previous_run_id IS NOT NULL)),
  CHECK ((delivery_run_id IS NULL AND delivery_params_sha256 IS NULL)
    OR (scope_run_id = run_id AND delivery_run_id IS NOT NULL AND delivery_params_sha256 IS NOT NULL))
);
CREATE INDEX office_run_materials_scope_idx ON office_run_materials (scope_run_id);
CREATE INDEX office_run_materials_delivery_owner_idx ON office_run_materials (owner_id)
  WHERE delivery_run_id IS NOT NULL;

CREATE TABLE office_attachments (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  -- The original login is audit/binding data, not an identity retention dependency.
  session_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  upload_conversation_id uuid,
  bound_conversation_id uuid,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  format text NOT NULL CHECK (format IN ('txt', 'markdown', 'csv')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 1048576),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  revoked_at timestamptz,
  content bytea CHECK (octet_length(content) = size_bytes),
  scope_run_id uuid,
  role text,
  FOREIGN KEY (upload_conversation_id, owner_id) REFERENCES conversations (id, owner_id),
  FOREIGN KEY (scope_run_id, owner_id, bound_conversation_id, session_id, draft_id)
    REFERENCES office_run_materials (run_id, owner_id, conversation_id, session_id, draft_id),
  CHECK (bound_conversation_id IS NULL OR upload_conversation_id IS NULL
    OR bound_conversation_id = upload_conversation_id),
  CHECK ((scope_run_id IS NULL AND bound_conversation_id IS NULL AND role IS NULL)
    OR (scope_run_id IS NOT NULL AND bound_conversation_id IS NOT NULL AND role IS NOT NULL
      AND ((role = 'notes' AND format IN ('txt', 'markdown')) OR (role = 'tasks' AND format = 'csv')))),
  UNIQUE (owner_id, session_id, draft_id, idempotency_key),
  UNIQUE (scope_run_id, role)
);
CREATE INDEX office_attachments_active_owner_idx ON office_attachments (owner_id, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX office_attachments_expiry_idx ON office_attachments (expires_at, id)
  WHERE content IS NOT NULL;

CREATE TABLE office_artifacts (
  id uuid PRIMARY KEY,
  scope_run_id uuid NOT NULL REFERENCES office_run_materials (run_id),
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  format text NOT NULL CHECK (format IN ('markdown', 'csv')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 2097152),
  sources_known boolean NOT NULL,
  uses_notes boolean NOT NULL,
  uses_tasks boolean NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  content bytea CHECK (octet_length(content) = size_bytes),
  CHECK (sources_known OR NOT (uses_notes OR uses_tasks)),
  UNIQUE (scope_run_id, format)
);
CREATE INDEX office_artifacts_expiry_idx ON office_artifacts (expires_at, id)
  WHERE content IS NOT NULL;

-- Office recovery envelopes have the same bounded shape as the existing Feishu envelope.
ALTER TABLE compact_continuations
  DROP CONSTRAINT compact_continuations_snapshot_check,
  DROP CONSTRAINT compact_continuations_context_check,
  ADD CONSTRAINT compact_continuations_snapshot_check CHECK (
    CASE WHEN snapshot ? 'encoding' THEN (
      snapshot->>'encoding' IN ('feishu-snapshot-aead/1', 'along-office-snapshot-aead/1')
      AND jsonb_typeof(snapshot->'ciphertext') = 'string'
      AND snapshot - 'encoding' - 'ciphertext' = '{}'::jsonb
      AND length(snapshot->>'ciphertext') BETWEEN 40 AND 1398140
    ) IS TRUE ELSE octet_length(snapshot::text) <= 1048576 END
  ),
  ADD CONSTRAINT compact_continuations_context_check CHECK (
    CASE WHEN context ? 'encoding' THEN (
      context->>'encoding' IN ('feishu-snapshot-aead/1', 'along-office-snapshot-aead/1')
      AND jsonb_typeof(context->'ciphertext') = 'string'
      AND context - 'encoding' - 'ciphertext' = '{}'::jsonb
      AND length(context->>'ciphertext') BETWEEN 40 AND 1398140
    ) IS TRUE ELSE octet_length(context::text) <= 1048576 END
  );

INSERT INTO schema_migrations(version) VALUES ('0042');
END;
$migration$;
COMMIT;
