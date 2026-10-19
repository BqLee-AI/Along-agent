-- verify-constraints.sql: pg_constraint / pg_trigger existence assertions (D3/D4/D5/D9).
-- Fails with RAISE EXCEPTION on the first missing object. Run after apply.sh.
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/verify-constraints.sql

DO $$
DECLARE
  missing text[];
BEGIN
  SELECT array_agg(q.need ORDER BY q.need) INTO missing
  FROM (
    -- D3: tasks composite unique on (id, fire_at_utc)
    SELECT 'tasks_id_fire_at_utc_uniq' AS need
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'tasks'::regclass
        AND contype = 'u'
        AND conname = 'tasks_id_fire_at_utc_uniq'
        AND pg_get_constraintdef(oid) = 'UNIQUE (id, fire_at_utc)'
    )
    -- D4: tasks unique on recreated_from_task_id
    UNION ALL
    SELECT 'tasks_recreated_from_task_id_uniq'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'tasks_recreated_from_task_id_uniq'
    )
    -- tasks check constraints
    UNION ALL
    SELECT 'tasks_kind_check'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'tasks_kind_check'
    )
    UNION ALL
    SELECT 'tasks_occurrence_check'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'tasks_occurrence_check'
    )
    UNION ALL
    SELECT 'tasks_state_check'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'tasks_state_check'
    )
    -- D5: task_events type check (seven-word closed set)
    UNION ALL
    SELECT 'task_events_type_check'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'task_events_type_check'
    )
    -- approvals constraints
    UNION ALL
    SELECT 'approvals_state_check'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'approvals_state_check'
    )
    UNION ALL
    SELECT 'approvals_occurrence_check'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'approvals_occurrence_check'
    )
    UNION ALL
    SELECT 'approvals_fold_check'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'approvals_fold_check'
    )
    UNION ALL
    SELECT 'approvals_consumed_task_id_uniq'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'approvals_consumed_task_id_uniq'
    )
    -- outbox constraints
    UNION ALL
    SELECT 'outbox_status_check'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'outbox_status_check'
    )
    UNION ALL
    SELECT 'outbox_idempotency_key_uniq'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'outbox_idempotency_key_uniq'
    )
    -- D9 (0010): outbox dispatch columns — ack_check_no range + dispatch index
    UNION ALL
    SELECT 'outbox_ack_check_no_check'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'outbox_ack_check_no_check'
    )
    UNION ALL
    SELECT 'outbox_dispatch_idx'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE indexname = 'outbox_dispatch_idx'
    )
    -- notifications constraints
    UNION ALL
    SELECT 'notifications_channel_check'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'notifications_channel_check'
    )
    UNION ALL
    SELECT 'notifications_status_check'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'notifications_status_check'
    )
    UNION ALL
    SELECT 'notifications_idempotency_key_uniq'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'notifications_idempotency_key_uniq'
    )
    -- security_events type check
    UNION ALL
    SELECT 'security_events_type_check'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'security_events_type_check'
    )
  ) q;

  IF missing IS NOT NULL AND array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'missing pg_constraint entries: %', array_to_string(missing, ', ');
  END IF;

  -- D5: append-only trigger must exist on task_events and be enabled.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'task_events_no_update_delete'
      AND tgrelid = 'task_events'::regclass
      AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'missing or disabled pg_trigger: task_events_no_update_delete on task_events';
  END IF;

  RAISE NOTICE 'constraints verified';
END;
$$;
