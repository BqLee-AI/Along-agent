-- Matched API/native/Web v6 writers only; preserve legacy frozen authority.
BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0021') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0020') THEN
    RAISE EXCEPTION '0020 must be applied before 0021';
  END IF;
  ALTER TABLE agent_runs ADD COLUMN goal_result jsonb NULL;
  ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_goal_result_check CHECK (
    goal_result IS NULL OR (
      frozen_context->>'authorization_revision' = 'delegation/1'
      AND status IN ('done','failed','cancelled')
      AND jsonb_typeof(goal_result) = 'object'
      AND goal_result->>'status' IN ('completed','partial','blocked','cancelled','unknown')
    )
  );
  INSERT INTO schema_migrations(version) VALUES ('0021');
END;
$migration$;
COMMIT;
