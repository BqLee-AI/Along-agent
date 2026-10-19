-- 0010 commitments outbox dispatch: scheduler worker operational columns.
-- Spec: docs/design/08-scheduler-and-delivery.md (outbox + retry + ACK_UNKNOWN).
-- Append-only rule: ALTERs existing outbox only; no new table; no 0001-0009 edits.

BEGIN;

ALTER TABLE outbox
  ADD COLUMN last_attempt_at timestamptz NULL,
  ADD COLUMN ack_check_no integer NOT NULL DEFAULT 0,
  ADD COLUMN provider_receipt_id text NULL,
  ADD COLUMN last_error text NULL;

ALTER TABLE outbox
  ADD CONSTRAINT outbox_ack_check_no_check CHECK (ack_check_no BETWEEN 0 AND 3);

CREATE INDEX outbox_dispatch_idx ON outbox (status, last_attempt_at);

COMMIT;
