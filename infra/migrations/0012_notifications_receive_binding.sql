-- Stop all old workers before applying this protocol cutover. Start the new
-- workers only after commit; old unbound notifications remain historical only.
BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Serialize the one-time decision with its DDL, data cutover, and ledger row.
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0012') THEN
    RETURN;
  END IF;

  ALTER TABLE notifications
    ADD COLUMN fire_at_utc timestamptz,
    ADD COLUMN expected_state_version integer,
    ADD CONSTRAINT notifications_receive_binding_complete
      CHECK ((fire_at_utc IS NULL) = (expected_state_version IS NULL)),
    ADD CONSTRAINT notifications_receive_version_positive
      CHECK (expected_state_version > 0);

  -- An old active send may already have entered its provider. Never grant it
  -- another call permit. Preserve its accumulated reconciliation count.
  UPDATE outbox AS o
  SET status = 'acked_unknown',
      last_attempt_at = now() + interval '30 seconds',
      last_error = 'legacy_send_uncertain',
      updated_at = now()
  FROM tasks AS t
  WHERE t.id = o.task_id
    AND t.state = 'scheduled'
    AND o.command->>'kind' = 'send'
    AND o.status IN ('pending', 'dispatched', 'acked_unknown');

  INSERT INTO schema_migrations (version) VALUES ('0012');
END;
$$;

COMMIT;
