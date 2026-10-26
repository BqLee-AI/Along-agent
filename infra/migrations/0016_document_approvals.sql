-- Stop legacy writers before this document-authority cutover; historical facts remain unchanged.
BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0016') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0015') THEN
    RAISE EXCEPTION '0015 must be applied before 0016';
  END IF;

CREATE TABLE document_approvals (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  run_id uuid NOT NULL,
  workspace_id text NOT NULL CHECK (length(workspace_id) > 0),
  workspace_grant jsonb NOT NULL CHECK (jsonb_typeof(workspace_grant) = 'object'),
  relative_path text NOT NULL CHECK (length(relative_path) > 0),
  base_read_invocation_id uuid NOT NULL,
  base_version text NOT NULL CHECK (base_version ~ '^[0-9a-f]{64}$'),
  exact_new_content text NOT NULL,
  new_version text NOT NULL CHECK (new_version ~ '^[0-9a-f]{64}$'),
  presentation_version text NOT NULL CHECK (presentation_version = 'document_replace.v1'),
  presentation_hash text NOT NULL CHECK (presentation_hash ~ '^[0-9a-f]{64}$'),
  preview jsonb NOT NULL CHECK (jsonb_typeof(preview) = 'object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected')),
  apply_invocation_id uuid UNIQUE,
  replaces_approval_id uuid UNIQUE REFERENCES document_approvals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (apply_invocation_id IS NULL OR state = 'approved'),
  CHECK (replaces_approval_id IS NULL OR replaces_approval_id <> id),
  CHECK (base_version <> new_version)
);
CREATE INDEX document_approvals_owner_run ON document_approvals(owner_id,run_id);
CREATE FUNCTION document_approvals_guard_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'document approvals cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - ARRAY['state','apply_invocation_id']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['state','apply_invocation_id']) THEN
    RAISE EXCEPTION 'document approval target and presentation are immutable';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT
     (OLD.state = 'pending' AND NEW.state IN ('approved','rejected')) THEN
    RAISE EXCEPTION 'document approval decision cannot be reversed';
  END IF;
  IF OLD.apply_invocation_id IS NOT NULL AND NEW.apply_invocation_id IS DISTINCT FROM OLD.apply_invocation_id THEN
    RAISE EXCEPTION 'document approval apply binding is immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER document_approvals_immutable BEFORE UPDATE OR DELETE ON document_approvals
  FOR EACH ROW EXECUTE FUNCTION document_approvals_guard_mutation();
CREATE FUNCTION document_approvals_guard_predecessor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE predecessor document_approvals;
BEGIN
  IF NEW.state <> 'pending' OR NEW.apply_invocation_id IS NOT NULL THEN
    RAISE EXCEPTION 'new document approvals must be pending and unbound';
  END IF;
  IF NEW.replaces_approval_id IS NOT NULL THEN
    SELECT * INTO predecessor FROM document_approvals WHERE id=NEW.replaces_approval_id;
    IF NOT FOUND OR predecessor.state <> 'approved' OR predecessor.apply_invocation_id IS NULL OR
       (predecessor.owner_id,predecessor.conversation_id,predecessor.run_id,predecessor.workspace_id,
        predecessor.workspace_grant,predecessor.relative_path) IS DISTINCT FROM
       (NEW.owner_id,NEW.conversation_id,NEW.run_id,NEW.workspace_id,NEW.workspace_grant,NEW.relative_path) THEN
      RAISE EXCEPTION 'document successor must reference an approved bound same-target predecessor';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER document_approvals_predecessor BEFORE INSERT ON document_approvals
  FOR EACH ROW EXECUTE FUNCTION document_approvals_guard_predecessor();

CREATE TABLE document_approval_decisions (
  owner_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  target_approval_id uuid NOT NULL REFERENCES document_approvals(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('confirm','reject')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,idempotency_key),
  CHECK ((action = 'confirm' AND decision = 'approved') OR (action = 'reject' AND decision = 'rejected'))
);
CREATE TRIGGER document_approval_decisions_append_only BEFORE UPDATE OR DELETE ON document_approval_decisions
  FOR EACH ROW EXECUTE FUNCTION run_checkpoints_reject_mutation();
INSERT INTO schema_migrations(version) VALUES ('0016');
END;
$migration$;
COMMIT;
