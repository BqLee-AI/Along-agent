-- Stop old writers; publish the v4 TS/native consumers together after migration.
BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='0019') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='0018') THEN
    RAISE EXCEPTION '0018 must be applied before 0019';
  END IF;

CREATE FUNCTION run_context_policy_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $policy$
DECLARE
  field text;
  number_value numeric;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(value) AS key) IS DISTINCT FROM
     ARRAY['completion_cap','input_meter','meter_revision','model_binding','model_window_tokens','reserve_tokens','revision'] THEN RETURN false; END IF;
  IF value->>'revision' IS DISTINCT FROM 'r2a/1'
    OR jsonb_typeof(value->'revision') IS DISTINCT FROM 'string'
    OR jsonb_typeof(value->'input_meter') IS DISTINCT FROM 'string'
    OR value->>'input_meter' NOT IN ('verified','estimated','unavailable')
    OR jsonb_typeof(value->'meter_revision') IS DISTINCT FROM 'string'
    OR length(value->>'meter_revision') NOT BETWEEN 1 AND 128
    OR (value->>'input_meter'<>'unavailable' AND value->>'meter_revision'='unavailable/1')
    OR jsonb_typeof(value->'model_binding') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(value->'model_binding') AS key)
    IS DISTINCT FROM ARRAY['adapter_revision','model'] THEN RETURN false; END IF;
  IF jsonb_typeof(value->'model_binding'->'model') IS DISTINCT FROM 'string'
    OR length(value->'model_binding'->>'model')<1
    OR jsonb_typeof(value->'model_binding'->'adapter_revision') IS DISTINCT FROM 'string'
    OR length(value->'model_binding'->>'adapter_revision') NOT BETWEEN 1 AND 128 THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['completion_cap','model_window_tokens','reserve_tokens'] LOOP
    IF field='model_window_tokens' AND value->field='null'::jsonb THEN CONTINUE; END IF;
    IF jsonb_typeof(value->field) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
    number_value := (value->>field)::numeric;
    IF number_value<>trunc(number_value) OR number_value>9007199254740991
      OR number_value < (CASE WHEN field='reserve_tokens' THEN 0 ELSE 1 END) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$policy$;
CREATE TABLE run_context_policies (
  run_id uuid PRIMARY KEY REFERENCES agent_runs(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL,
  policy jsonb NOT NULL,
  policy_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_context_policies_policy_check CHECK (run_context_policy_valid(policy)),
  CONSTRAINT run_context_policies_hash_check CHECK (policy_hash ~ '^[0-9a-f]{64}$')
);
CREATE FUNCTION run_context_policies_guard_owner() RETURNS trigger LANGUAGE plpgsql AS $owner$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM agent_runs WHERE id=NEW.run_id AND owner_id=NEW.owner_id AND execution='harness') THEN
    RAISE EXCEPTION 'context policy owner and harness Run must match';
  END IF;
  RETURN NEW;
END;
$owner$;
CREATE TRIGGER run_context_policies_owner BEFORE INSERT ON run_context_policies
  FOR EACH ROW EXECUTE FUNCTION run_context_policies_guard_owner();
CREATE TRIGGER run_context_policies_no_update_delete BEFORE UPDATE OR DELETE ON run_context_policies
  FOR EACH ROW EXECUTE FUNCTION run_checkpoints_reject_mutation();
INSERT INTO schema_migrations(version) VALUES('0019');
END;
$migration$;
COMMIT;
