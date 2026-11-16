BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='0031') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='0030') THEN
    RAISE EXCEPTION '0030 must be applied before 0031';
  END IF;
  -- Private acceptance evidence, not a tool observation or a source of authority.
  CREATE TABLE r3_memory_recall_receipts (
    invocation_id uuid PRIMARY KEY REFERENCES tool_invocations(invocation_id) ON DELETE RESTRICT,
    owner_id uuid NOT NULL,
    revisions jsonb NOT NULL CHECK (jsonb_typeof(revisions)='array' AND jsonb_array_length(revisions)<=100),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE FUNCTION r3_memory_recall_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'memory recall receipt is immutable';
  END;
  $$;
  CREATE TRIGGER r3_memory_recall_receipt_no_mutation BEFORE UPDATE OR DELETE ON r3_memory_recall_receipts
    FOR EACH ROW EXECUTE FUNCTION r3_memory_recall_receipt_immutable();
  INSERT INTO schema_migrations(version) VALUES ('0031');
END;
$migration$;
COMMIT;
