-- Elapsed provenance is forward-only; existing task facts are not rewritten.
BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0024') THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0023') THEN
    RAISE EXCEPTION '0023 must be applied before 0024';
  END IF;

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

  INSERT INTO schema_migrations(version) VALUES ('0024');
END;
$migration$;
COMMIT;
