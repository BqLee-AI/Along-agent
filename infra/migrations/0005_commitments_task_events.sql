-- 0005 commitments task_events: append-only evidence ledger (D5).
-- Spec: docs/schema/commitments-schema.md (task_events section),
-- docs/design/07-task-events-ledger.md (closed vocabulary).
-- Enforcement: BEFORE UPDATE OR DELETE trigger raising an exception.
-- Rationale: a trigger also fires for owner/superuser connections, while
-- REVOKE-based or RLS-based enforcement does not constrain table owners.
-- v0 does not defend against local tampering (design/07 section 0);
-- cloud adds an independent read-only checker. TRUNCATE/DISABLE TRIGGER
-- by a privileged local connection remain out of v0 scope.

BEGIN;

CREATE TABLE task_events (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  task_id uuid NOT NULL REFERENCES tasks (id) ON DELETE RESTRICT,
  state_version integer NOT NULL,
  type text NOT NULL,
  recorded_at_utc timestamptz NOT NULL DEFAULT now(),
  evidence_ref text NOT NULL DEFAULT 'local',
  CONSTRAINT task_events_type_check CHECK (type IN ('created', 'scheduled', 'fired', 'missed', 'cancel_requested', 'cancelled', 'reconciliation_run'))
);

CREATE INDEX task_events_task_version_idx ON task_events (task_id, state_version);
CREATE INDEX task_events_owner_recorded_idx ON task_events (owner_id, recorded_at_utc DESC);

CREATE OR REPLACE FUNCTION task_events_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'task_events is append-only';
END;
$$;

CREATE TRIGGER task_events_no_update_delete
  BEFORE UPDATE OR DELETE ON task_events
  FOR EACH ROW
  EXECUTE FUNCTION task_events_reject_mutation();

COMMIT;
