-- 0003 commitments approvals: confirmation-gate first-class row.
-- Spec: docs/schema/commitments-schema.md (approvals section).
-- Numbers 0001/0002 are reserved for identity and conversation/runs groups.
-- owner_id and conversation_id are logical references only: no FK to users.

BEGIN;

CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  conversation_id uuid NULL,
  original_text text NULL,
  fire_at_utc timestamptz NOT NULL,
  wall_time text NOT NULL,
  timezone_id text NOT NULL,
  fold smallint NOT NULL DEFAULT 0,
  resolved_utc_offset_seconds integer NOT NULL,
  tzdb_version text NOT NULL,
  occurrence text NOT NULL DEFAULT 'single',
  presentation_hash text NOT NULL,
  presentation_version text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_task_id uuid NULL,
  supersedes_approval_id uuid NULL,
  CONSTRAINT approvals_fold_check CHECK (fold IN (0, 1)),
  CONSTRAINT approvals_occurrence_check CHECK (occurrence = 'single'),
  CONSTRAINT approvals_state_check CHECK (state IN ('pending', 'consumed', 'rejected', 'expired', 'superseded')),
  CONSTRAINT approvals_consumed_task_id_uniq UNIQUE (consumed_task_id)
);

CREATE INDEX approvals_owner_state_idx ON approvals (owner_id, state);
CREATE INDEX approvals_expires_at_idx ON approvals (expires_at);

COMMIT;
