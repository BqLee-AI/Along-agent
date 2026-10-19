-- 0004 commitments tasks: formal scheduled object (D3/D4).
-- Spec: docs/schema/commitments-schema.md (tasks section).
-- Contract UNIQUE(task_id, fire_at) lands as unique(id, fire_at_utc); see
-- commitments-schema.md constraint note: the authoritative mapping is honored here.

BEGIN;

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'notify_only',
  source_approval_id uuid NULL,
  recreated_from_task_id uuid NULL,
  fire_at_utc timestamptz NOT NULL,
  wall_time text NOT NULL,
  timezone_id text NOT NULL,
  fold smallint NOT NULL DEFAULT 0,
  resolved_utc_offset_seconds integer NOT NULL,
  tzdb_version text NOT NULL,
  occurrence text NOT NULL DEFAULT 'once',
  state text NOT NULL DEFAULT 'saved',
  state_version integer NOT NULL DEFAULT 1,
  schedule_receipt text NULL,
  original_note text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tasks_kind_check CHECK (kind = 'notify_only'),
  CONSTRAINT tasks_occurrence_check CHECK (occurrence = 'once'),
  CONSTRAINT tasks_state_check CHECK (state IN ('saved', 'pending_schedule', 'scheduled', 'fired', 'missed', 'cancel_pending', 'cancelled')),
  CONSTRAINT tasks_id_fire_at_utc_uniq UNIQUE (id, fire_at_utc),
  CONSTRAINT tasks_recreated_from_task_id_uniq UNIQUE (recreated_from_task_id)
);

CREATE INDEX tasks_owner_state_idx ON tasks (owner_id, state);
CREATE INDEX tasks_fire_at_utc_idx ON tasks (fire_at_utc);
CREATE INDEX tasks_owner_fire_at_idx ON tasks (owner_id, fire_at_utc);

COMMIT;
