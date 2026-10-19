-- 0007 commitments notifications: in-app trigger notice (v0 in-app only).
-- Spec: docs/schema/commitments-schema.md (notifications section).

BEGIN;

CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  task_id uuid NOT NULL REFERENCES tasks (id) ON DELETE RESTRICT,
  channel text NOT NULL DEFAULT 'inapp',
  title text NOT NULL,
  body text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz NULL,
  CONSTRAINT notifications_channel_check CHECK (channel = 'inapp'),
  CONSTRAINT notifications_status_check CHECK (status IN ('pending', 'sent', 'failed')),
  CONSTRAINT notifications_idempotency_key_uniq UNIQUE (idempotency_key)
);

CREATE INDEX notifications_owner_created_idx ON notifications (owner_id, created_at DESC);
CREATE INDEX notifications_task_idx ON notifications (task_id);

COMMIT;
