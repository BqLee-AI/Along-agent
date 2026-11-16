BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='0029') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='0028') THEN
    RAISE EXCEPTION '0028 must be applied before 0029';
  END IF;
  ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_status_check;
  ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check CHECK
    (status IN ('running','suspended_approval','paused','done','failed','cancelled'));
  CREATE TABLE harness_pauses (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
    run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
    attempt_id uuid NOT NULL REFERENCES run_attempts(id) ON DELETE RESTRICT,
    idempotency_key uuid NOT NULL,
    reason text NOT NULL CHECK (reason IN ('user')),
    purpose text NOT NULL CHECK (purpose IN ('none')),
    resume_source text NOT NULL CHECK (resume_source IN ('user')),
    state text NOT NULL CHECK (state IN ('pending','paused','consumed','invalidated')),
    snapshot jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(owner_id,idempotency_key),
    CHECK (reason='user' AND purpose='none' AND resume_source='user'),
    CHECK ((state='pending' AND snapshot IS NULL) OR state='invalidated' OR
           (state IN ('paused','consumed') AND snapshot IS NOT NULL))
  );
  CREATE UNIQUE INDEX harness_pauses_one_live_run ON harness_pauses(run_id)
    WHERE state IN ('pending','paused');
  CREATE TABLE harness_pause_resumes (
    owner_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
    pause_id uuid NOT NULL UNIQUE REFERENCES harness_pauses(id) ON DELETE RESTRICT,
    attempt_id uuid NOT NULL UNIQUE REFERENCES run_attempts(id) ON DELETE RESTRICT,
    source text NOT NULL CHECK (source IN ('user')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(owner_id,idempotency_key)
  );
  CREATE TRIGGER harness_pause_resumes_no_update_delete BEFORE UPDATE OR DELETE ON harness_pause_resumes
    FOR EACH ROW EXECUTE FUNCTION run_checkpoints_reject_mutation();
  INSERT INTO schema_migrations(version) VALUES ('0029');
END;
$migration$;
COMMIT;
