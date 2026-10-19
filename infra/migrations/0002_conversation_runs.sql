-- 0002 conversation runs: conversation + execution archive base (D6).
-- Spec: docs/schema/conversation-and-runs-schema.md,
-- docs/schema/README.md (v0 landing order), docs/design/13-p0-bootstrap-and-ci-rules.md D6.
-- Enforcement: BEFORE UPDATE OR DELETE triggers raising P0001 on the
-- immutable / append-only tables (agent_revisions, prompt_versions,
-- run_checkpoints). Rationale mirrors 0005: a trigger also fires for
-- owner/superuser connections, while REVOKE-based or RLS-based enforcement
-- does not constrain table owners. TRUNCATE / DISABLE TRIGGER by a privileged
-- local connection remain out of v0 scope; cloud adds an independent
-- read-only checker.
-- Scope notes:
-- - Physical FKs stay inside the conversation module only
--   (messages/agent_runs -> conversations, attempts -> runs,
--   checkpoints -> attempts). agent_runs.agent_revision and
--   agent_revisions.prompt_version are logical references, no FK
--   (immutable + cross-module ids only).
-- - messages.request_id UNIQUE lands the schema [Proposed]: duplicate
--   request_id is rejected 23505, so BFF resends must reuse the idempotent
--   result path instead of re-inserting.
-- - tool_calls audit rows belong to ToolGateway (issue #9); no table is
--   created here. When #9 lands tool_calls it must reuse the same
--   BEFORE UPDATE OR DELETE trigger shape.

BEGIN;

CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  title text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  confirmed_timezone_id text NULL,
  anchor_received_at_utc timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_status_check CHECK (status IN ('open', 'closed'))
);

CREATE INDEX conversations_owner_created_idx ON conversations (owner_id, created_at DESC);
CREATE INDEX conversations_owner_status_idx ON conversations (owner_id, status);

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE RESTRICT,
  role text NOT NULL,
  content text NOT NULL,
  request_id text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_role_check CHECK (role IN ('user', 'assistant', 'system')),
  CONSTRAINT messages_request_id_uniq UNIQUE (request_id)
);

CREATE INDEX messages_conversation_created_idx ON messages (conversation_id, created_at);
CREATE INDEX messages_owner_created_idx ON messages (owner_id, created_at DESC);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE RESTRICT,
  agent_revision text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  budget_max_iterations integer NOT NULL,
  budget_max_tokens integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz NULL,
  CONSTRAINT agent_runs_mode_check CHECK (mode IN ('chat', 'task')),
  CONSTRAINT agent_runs_status_check CHECK (status IN ('running', 'suspended_approval', 'done', 'failed', 'cancelled'))
);

CREATE INDEX agent_runs_conversation_created_idx ON agent_runs (conversation_id, created_at);
CREATE INDEX agent_runs_owner_status_idx ON agent_runs (owner_id, status);

CREATE TABLE run_attempts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES agent_runs (id) ON DELETE RESTRICT,
  attempt_no integer NOT NULL,
  lease_token uuid NULL,
  lease_expires_at timestamptz NULL,
  status text NOT NULL DEFAULT 'running',
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz NULL,
  CONSTRAINT run_attempts_status_check CHECK (status IN ('running', 'done', 'failed', 'fenced_out')),
  CONSTRAINT run_attempts_run_attempt_no_uniq UNIQUE (run_id, attempt_no)
);

CREATE INDEX run_attempts_run_created_idx ON run_attempts (run_id, created_at);

CREATE TABLE run_checkpoints (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  attempt_id uuid NOT NULL REFERENCES run_attempts (id) ON DELETE RESTRICT,
  seq integer NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  stream_protocol_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_checkpoints_kind_check CHECK (kind IN ('thinking', 'tool_call', 'tool_result', 'approval_required', 'answer')),
  CONSTRAINT run_checkpoints_attempt_seq_uniq UNIQUE (attempt_id, seq)
);

CREATE TABLE agent_revisions (
  id uuid PRIMARY KEY,
  owner_id uuid NULL,
  name text NOT NULL,
  revision text NOT NULL,
  prompt_version text NOT NULL,
  tools_allowlist jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_revisions_name_revision_uniq UNIQUE (name, revision)
);

CREATE TABLE prompt_versions (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  version text NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompt_versions_name_version_uniq UNIQUE (name, version)
);

CREATE OR REPLACE FUNCTION agent_revisions_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent_revisions is immutable; publish a new revision';
END;
$$;

CREATE TRIGGER agent_revisions_no_update_delete
  BEFORE UPDATE OR DELETE ON agent_revisions
  FOR EACH ROW
  EXECUTE FUNCTION agent_revisions_reject_mutation();

CREATE OR REPLACE FUNCTION prompt_versions_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'prompt_versions is immutable; publish a new version';
END;
$$;

CREATE TRIGGER prompt_versions_no_update_delete
  BEFORE UPDATE OR DELETE ON prompt_versions
  FOR EACH ROW
  EXECUTE FUNCTION prompt_versions_reject_mutation();

CREATE OR REPLACE FUNCTION run_checkpoints_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'run_checkpoints is append-only';
END;
$$;

CREATE TRIGGER run_checkpoints_no_update_delete
  BEFORE UPDATE OR DELETE ON run_checkpoints
  FOR EACH ROW
  EXECUTE FUNCTION run_checkpoints_reject_mutation();

COMMIT;
