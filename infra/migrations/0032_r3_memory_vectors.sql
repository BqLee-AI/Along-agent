-- Optional, rebuildable memory embeddings. No extension is installed by this migration.
BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='0032') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='0031') THEN
    RAISE EXCEPTION '0031 must be applied before 0032';
  END IF;
  CREATE TABLE r3_memory_vectors (
    owner_id uuid NOT NULL,
    memory_id uuid NOT NULL,
    revision integer NOT NULL,
    binding_sha256 text NOT NULL CHECK (binding_sha256 ~ '^[a-f0-9]{64}$'),
    embedding real[] NOT NULL CHECK (cardinality(embedding)=512 AND array_position(embedding, NULL) IS NULL),
    indexed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, memory_id, revision, binding_sha256),
    FOREIGN KEY (owner_id, memory_id, revision) REFERENCES r3_memory_revisions(owner_id, memory_id, revision)
  );
  INSERT INTO schema_migrations(version) VALUES ('0032');
END;
$migration$;
COMMIT;
