-- 0009 commitments security_events: cancel-breach ledger, no task cascade (S0 #14).
-- Spec: docs/schema/commitments-schema.md (security_events section).

BEGIN;

CREATE TABLE security_events (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  task_id uuid NULL,
  type text NOT NULL,
  recorded_at_utc timestamptz NOT NULL DEFAULT now(),
  evidence_ref text NOT NULL DEFAULT 'local',
  CONSTRAINT security_events_type_check CHECK (type = 'cancel_breach')
);

COMMIT;
