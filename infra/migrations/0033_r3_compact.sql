BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='0033') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='0032') THEN
    RAISE EXCEPTION '0032 must be applied before 0033';
  END IF;
  ALTER TABLE harness_pauses DROP CONSTRAINT harness_pauses_reason_check, DROP CONSTRAINT harness_pauses_purpose_check, DROP CONSTRAINT harness_pauses_resume_source_check, DROP CONSTRAINT harness_pauses_check;
  ALTER TABLE harness_pauses ADD CONSTRAINT harness_pauses_reason_check CHECK (reason IN ('user','runtime')),
    ADD CONSTRAINT harness_pauses_purpose_check CHECK (purpose IN ('none','manual_compact','automatic_compact')),
    ADD CONSTRAINT harness_pauses_resume_source_check CHECK (resume_source IN ('user','runtime')),
    ADD CONSTRAINT harness_pauses_check CHECK ((reason='user' AND purpose='none' AND resume_source='user') OR
      (reason='runtime' AND purpose IN ('manual_compact','automatic_compact') AND resume_source='runtime'));
  ALTER TABLE harness_pause_resumes DROP CONSTRAINT harness_pause_resumes_source_check;
  ALTER TABLE harness_pause_resumes ADD CONSTRAINT harness_pause_resumes_source_check CHECK (source IN ('user','runtime'));
  CREATE TABLE compact_freezes (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
    run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
    attempt_id uuid NOT NULL REFERENCES run_attempts(id) ON DELETE RESTRICT,
    pause_id uuid NOT NULL REFERENCES harness_pauses(id) ON DELETE RESTRICT,
    previous_summary_id uuid,
    previous_revision bigint NOT NULL CHECK (previous_revision >= 0),
    model_id text NOT NULL CHECK (length(model_id) BETWEEN 1 AND 512),
    prompt_revision text NOT NULL CHECK (length(prompt_revision) BETWEEN 1 AND 128),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE compact_freeze_sources (
    freeze_id uuid NOT NULL REFERENCES compact_freezes(id) ON DELETE RESTRICT,
    position integer NOT NULL CHECK (position >= 0),
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    source_hash bytea NOT NULL CHECK (octet_length(source_hash)=32),
    PRIMARY KEY(freeze_id,position), UNIQUE(freeze_id,message_id)
  );
  CREATE TABLE compact_summaries (
    id uuid PRIMARY KEY,
    freeze_id uuid NOT NULL UNIQUE REFERENCES compact_freezes(id) ON DELETE RESTRICT,
    owner_id uuid NOT NULL,
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
    previous_summary_id uuid REFERENCES compact_summaries(id) ON DELETE RESTRICT,
    revision bigint NOT NULL CHECK (revision > 0),
    summary_text text NOT NULL CHECK (octet_length(summary_text) BETWEEN 1 AND 65536),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(conversation_id,revision)
  );
  ALTER TABLE compact_freezes ADD FOREIGN KEY(previous_summary_id) REFERENCES compact_summaries(id) ON DELETE RESTRICT;
  CREATE TABLE compact_summary_sources (
    summary_id uuid NOT NULL REFERENCES compact_summaries(id) ON DELETE RESTRICT,
    position integer NOT NULL CHECK (position >= 0),
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    source_hash bytea NOT NULL CHECK (octet_length(source_hash)=32),
    PRIMARY KEY(summary_id,position), UNIQUE(summary_id,message_id)
  );
  CREATE TABLE compact_heads (
    conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE RESTRICT,
    owner_id uuid NOT NULL,
    summary_id uuid NOT NULL UNIQUE REFERENCES compact_summaries(id) ON DELETE RESTRICT,
    revision bigint NOT NULL CHECK (revision > 0)
  );
  CREATE TRIGGER compact_freezes_immutable BEFORE UPDATE OR DELETE ON compact_freezes FOR EACH ROW EXECUTE FUNCTION run_checkpoints_reject_mutation();
  CREATE TRIGGER compact_freeze_sources_immutable BEFORE UPDATE OR DELETE ON compact_freeze_sources FOR EACH ROW EXECUTE FUNCTION run_checkpoints_reject_mutation();
  CREATE TRIGGER compact_summaries_immutable BEFORE UPDATE OR DELETE ON compact_summaries FOR EACH ROW EXECUTE FUNCTION run_checkpoints_reject_mutation();
  CREATE TRIGGER compact_summary_sources_immutable BEFORE UPDATE OR DELETE ON compact_summary_sources FOR EACH ROW EXECUTE FUNCTION run_checkpoints_reject_mutation();
  INSERT INTO schema_migrations(version) VALUES ('0033');
END;
$migration$;
COMMIT;