BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT FROM schema_migrations WHERE version = '0045') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT FROM schema_migrations WHERE version = '0044') THEN
    RAISE EXCEPTION '0044 must be applied before 0045';
  END IF;

  CREATE TABLE personal_skills (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision > 0),
    disabled_at timestamptz,
    UNIQUE (owner_id, id)
  );

  CREATE TABLE personal_skill_revisions (
    skill_id uuid NOT NULL REFERENCES personal_skills (id),
    revision integer NOT NULL CHECK (revision > 0),
    name text NOT NULL,
    description text NOT NULL,
    body text NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 16384),
    PRIMARY KEY (skill_id, revision)
  );

  ALTER TABLE personal_skills ADD CONSTRAINT personal_skills_current_revision_fk
    FOREIGN KEY (id, current_revision) REFERENCES personal_skill_revisions (skill_id, revision)
    DEFERRABLE INITIALLY DEFERRED;

  CREATE TABLE personal_skill_requests (
    owner_id uuid NOT NULL,
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    request_hash text NOT NULL,
    skill_id uuid NOT NULL,
    PRIMARY KEY (owner_id, idempotency_key),
    FOREIGN KEY (owner_id, skill_id) REFERENCES personal_skills (owner_id, id)
  );

  CREATE FUNCTION personal_skill_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'personal skill revisions are immutable';
  END;
  $$;
  CREATE TRIGGER personal_skill_revision_no_mutation
    BEFORE UPDATE OR DELETE ON personal_skill_revisions
    FOR EACH ROW EXECUTE FUNCTION personal_skill_revision_immutable();

  CREATE FUNCTION personal_skill_guard_state() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.id <> OLD.id OR NEW.owner_id <> OLD.owner_id OR OLD.disabled_at IS NOT NULL
      OR (NEW.disabled_at IS NOT NULL AND NEW.current_revision <> OLD.current_revision)
      OR (NEW.disabled_at IS NULL AND NEW.current_revision <> OLD.current_revision + 1)
    THEN
      RAISE EXCEPTION 'invalid personal skill transition';
    END IF;
    RETURN NEW;
  END;
  $$;
  CREATE TRIGGER personal_skill_state_guard BEFORE UPDATE ON personal_skills
    FOR EACH ROW EXECUTE FUNCTION personal_skill_guard_state();

  -- Keep old configurations readable and untouched. The relation lives in the Bot config.
  CREATE FUNCTION personal_bot_skill_config_valid(config jsonb) RETURNS boolean
  IMMUTABLE STRICT LANGUAGE plpgsql AS $$
  BEGIN
    IF jsonb_typeof(config) <> 'object' THEN RETURN false; END IF;
    IF NOT personal_bot_config_valid(config - 'skill_ids') THEN RETURN false; END IF;
    IF NOT (config ? 'skill_ids') THEN RETURN true; END IF;
    IF jsonb_typeof(config->'skill_ids') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    RETURN NOT EXISTS (SELECT FROM jsonb_array_elements(config->'skill_ids') AS skill(value)
      WHERE jsonb_typeof(value) <> 'string'
        OR (value #>> '{}') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$');
  END;
  $$;
  ALTER TABLE personal_bots DROP CONSTRAINT personal_bot_config_shape,
    ADD CONSTRAINT personal_bot_config_shape CHECK (personal_bot_skill_config_valid(config));

  ALTER TABLE messages ADD COLUMN skill jsonb;

  INSERT INTO schema_migrations (version) VALUES ('0045');
END;
$migration$;
COMMIT;
