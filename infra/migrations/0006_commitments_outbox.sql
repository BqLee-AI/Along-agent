-- 0006 commitments outbox: cross-boundary staging row for delivery workers.
-- Spec: docs/schema/commitments-schema.md (outbox section).

BEGIN;

CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  task_id uuid NOT NULL REFERENCES tasks (id) ON DELETE RESTRICT,
  expected_state_version integer NOT NULL,
  command jsonb NOT NULL,
  idempotency_key text NOT NULL,
  attempt_no integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_status_check CHECK (status IN ('pending', 'dispatched', 'acked_unknown', 'superseded', 'failed_deadline')),
  CONSTRAINT outbox_idempotency_key_uniq UNIQUE (idempotency_key)
);

CREATE INDEX outbox_status_created_idx ON outbox (status, created_at);
CREATE INDEX outbox_task_idx ON outbox (task_id);

COMMIT;
