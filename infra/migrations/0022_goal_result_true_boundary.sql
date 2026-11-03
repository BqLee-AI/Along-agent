-- Require a true delegated terminal fact, not SQL NULL from missing legacy keys.
BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0022') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0021') THEN
    RAISE EXCEPTION '0021 must be applied before 0022';
  END IF;
  ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_goal_result_check;
  ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_goal_result_check CHECK (
    goal_result IS NULL OR (
      frozen_context->>'authorization_revision' = 'delegation/1'
      AND status IN ('done','failed','cancelled')
      AND jsonb_typeof(goal_result) = 'object'
      AND goal_result->>'status' IN ('completed','partial','blocked','cancelled','unknown')
    ) IS TRUE
  );
  INSERT INTO schema_migrations(version) VALUES ('0022');
END;
$migration$;
COMMIT;
