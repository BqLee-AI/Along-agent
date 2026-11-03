-- Wall/calendar direct creation provenance. Existing frozen tasks are not rewritten.
BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0023') THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0022') THEN
    RAISE EXCEPTION '0022 must be applied before 0023';
  END IF;

  ALTER TABLE tasks
    ADD COLUMN source_invocation_id uuid NULL
      REFERENCES tool_invocations(invocation_id) ON DELETE RESTRICT,
    ADD CONSTRAINT tasks_source_invocation_id_uniq UNIQUE (source_invocation_id),
    ADD CONSTRAINT tasks_source_xor_check CHECK (
      num_nonnulls(source_approval_id, source_invocation_id) <= 1
    );

  -- Historical tasks could have no recorded source. They remain readable and
  -- schedulable without backfilling invented provenance. All new tasks and any
  -- explicit source update must have exactly one real source field.
  CREATE FUNCTION tasks_require_creation_source() RETURNS trigger
    LANGUAGE plpgsql AS $function$
  BEGIN
    IF num_nonnulls(NEW.source_approval_id, NEW.source_invocation_id) <> 1 THEN
      RAISE EXCEPTION 'task requires exactly one creation source'
        USING ERRCODE = '23514', CONSTRAINT = 'tasks_source_xor_check';
    END IF;
    RETURN NEW;
  END;
  $function$;
  CREATE TRIGGER tasks_creation_source_required
    BEFORE INSERT OR UPDATE OF source_approval_id, source_invocation_id ON tasks
    FOR EACH ROW EXECUTE FUNCTION tasks_require_creation_source();

  INSERT INTO schema_migrations(version) VALUES ('0023');
END;
$migration$;
COMMIT;
