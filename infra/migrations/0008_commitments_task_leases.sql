-- 0008 commitments task_leases: scheduler claim lease, one row per task (S0 #14).
-- Spec: docs/schema/commitments-schema.md (task_leases section).

BEGIN;

CREATE TABLE task_leases (
  task_id uuid PRIMARY KEY REFERENCES tasks (id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL,
  expected_state_version integer NOT NULL,
  lease_owner text NOT NULL,
  lease_expires_at timestamptz NOT NULL
);

COMMIT;
