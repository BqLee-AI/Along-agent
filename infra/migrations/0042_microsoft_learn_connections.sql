BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0042') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0041') THEN
    RAISE EXCEPTION '0041 must be applied before 0042';
  END IF;

CREATE TABLE microsoft_learn_connections (
  owner_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  generation uuid NOT NULL
);

INSERT INTO schema_migrations(version) VALUES ('0042');
END;
$migration$;
COMMIT;
