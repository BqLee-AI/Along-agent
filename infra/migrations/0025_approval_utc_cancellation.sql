-- Permit cancellation snapshots of UTC elapsed tasks without inventing rules.
-- Existing approval rows and their presentation hashes remain untouched.
BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0025') THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0024') THEN
    RAISE EXCEPTION '0024 must be applied before 0025';
  END IF;

  ALTER TABLE approvals
    ALTER COLUMN tzdb_version DROP NOT NULL,
    ADD CONSTRAINT approvals_tzdb_version_check CHECK (
      tzdb_version IS NOT NULL OR
      (kind = 'cancel_task' AND timezone_id = 'UTC' AND fold = 0 AND resolved_utc_offset_seconds = 0)
    );

  CREATE FUNCTION approvals_guard_null_tzdb() RETURNS trigger LANGUAGE plpgsql AS $function$
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
  $function$;
  CREATE TRIGGER approvals_null_tzdb_guard BEFORE INSERT OR UPDATE ON approvals
    FOR EACH ROW EXECUTE FUNCTION approvals_guard_null_tzdb();

  INSERT INTO schema_migrations(version) VALUES ('0025');
END;
$migration$;
COMMIT;
