-- R3 memory is derived data; original messages remain owned by conversations.
BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='0030') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='0029') THEN
    RAISE EXCEPTION '0029 must be applied before 0030';
  END IF;

CREATE TABLE r3_memories (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  current_revision integer NOT NULL CHECK (current_revision > 0),
  status text NOT NULL CHECK (status IN ('active', 'stopped')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, id)
);

CREATE TABLE r3_memory_revisions (
  owner_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  conversation_id uuid NOT NULL,
  message_ids uuid[] NOT NULL CHECK (cardinality(message_ids) > 0 AND array_position(message_ids, NULL) IS NULL),
  content text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 12000),
  source_kind text NOT NULL CHECK (source_kind IN ('explicit', 'compact')),
  summary_id uuid,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, memory_id, revision),
  FOREIGN KEY (owner_id, memory_id) REFERENCES r3_memories (owner_id, id),
  CHECK ((source_kind = 'compact') = (summary_id IS NOT NULL))
);

ALTER TABLE r3_memories ADD CONSTRAINT r3_memories_current_revision_fk
  FOREIGN KEY (owner_id, id, current_revision)
  REFERENCES r3_memory_revisions (owner_id, memory_id, revision)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE r3_memory_requests (
  owner_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL,
  memory_id uuid NOT NULL,
  PRIMARY KEY (owner_id, idempotency_key),
  FOREIGN KEY (owner_id, memory_id) REFERENCES r3_memories (owner_id, id)
);

CREATE INDEX r3_memories_owner_active_idx ON r3_memories (owner_id, id) WHERE status = 'active';

CREATE FUNCTION r3_memory_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'memory revisions are immutable';
END;
$$;
CREATE TRIGGER r3_memory_revision_no_mutation BEFORE UPDATE OR DELETE ON r3_memory_revisions
  FOR EACH ROW EXECUTE FUNCTION r3_memory_revision_immutable();
  INSERT INTO schema_migrations(version) VALUES ('0030');
END;
$migration$;

COMMIT;
