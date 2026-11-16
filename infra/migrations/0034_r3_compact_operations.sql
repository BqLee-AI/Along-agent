BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='0034') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='0033') THEN
    RAISE EXCEPTION '0033 must be applied before 0034';
  END IF;

  CREATE UNIQUE INDEX harness_pauses_compact_binding ON harness_pauses
    (id,owner_id,conversation_id,run_id,attempt_id);
  CREATE TABLE compact_operations (
    pause_id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    run_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('pending','running','published','failed','cancelled')),
    freeze_id uuid UNIQUE REFERENCES compact_freezes(id) ON DELETE RESTRICT,
    summary_id uuid UNIQUE REFERENCES compact_summaries(id) ON DELETE RESTRICT,
    error_code text CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 128),
    call_started boolean NOT NULL DEFAULT false,
    usage_recorded boolean NOT NULL DEFAULT false,
    usage_tokens bigint CHECK (usage_tokens IS NULL OR usage_tokens >= 0),
    candidate_status text NOT NULL DEFAULT 'pending' CHECK (candidate_status IN ('pending','saved','failed','cancelled')),
    candidate_error_code text CHECK (candidate_error_code IS NULL OR length(candidate_error_code) BETWEEN 1 AND 128),
    candidate_saved_count integer NOT NULL DEFAULT 0 CHECK (candidate_saved_count >= 0),
    candidate_failed_count integer NOT NULL DEFAULT 0 CHECK (candidate_failed_count >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (pause_id,owner_id,conversation_id,run_id,attempt_id)
      REFERENCES harness_pauses(id,owner_id,conversation_id,run_id,attempt_id) ON DELETE RESTRICT,
    CHECK (NOT usage_recorded OR call_started),
    CHECK (usage_tokens IS NULL OR usage_recorded),
    CHECK (status <> 'running' OR (call_started AND freeze_id IS NOT NULL)),
    CHECK (status <> 'published' OR (call_started AND usage_recorded AND summary_id IS NOT NULL)),
    CHECK (summary_id IS NULL OR status = 'published'),
    CHECK (status <> 'failed' OR error_code IS NOT NULL),
    CHECK (candidate_status <> 'failed' OR candidate_error_code IS NOT NULL)
  );
  CREATE TABLE compact_continuations (
    pause_id uuid PRIMARY KEY REFERENCES compact_operations(pause_id) ON DELETE RESTRICT,
    attempt_id uuid NOT NULL UNIQUE REFERENCES run_attempts(id) ON DELETE RESTRICT,
    snapshot jsonb NOT NULL CHECK (octet_length(snapshot::text) <= 1048576),
    context jsonb NOT NULL CHECK (octet_length(context::text) <= 1048576),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TRIGGER compact_continuations_immutable BEFORE UPDATE OR DELETE ON compact_continuations
    FOR EACH ROW EXECUTE FUNCTION run_checkpoints_reject_mutation();
  INSERT INTO schema_migrations(version) VALUES ('0034');
END;
$migration$;
COMMIT;
