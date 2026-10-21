-- Controlled stop-write deployment; dirty historical chains abort unchanged.
BEGIN;

-- 0012 owns creation of the minimal migration ledger.
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0013') THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0012') THEN
    RAISE EXCEPTION '0012 must be applied before 0013';
  END IF;

  LOCK TABLE approvals IN ACCESS EXCLUSIVE MODE;

  IF EXISTS (
    SELECT supersedes_approval_id FROM approvals
    WHERE supersedes_approval_id IS NOT NULL
    GROUP BY supersedes_approval_id HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM approvals AS child
    LEFT JOIN approvals AS parent ON parent.id = child.supersedes_approval_id
    WHERE child.supersedes_approval_id IS NOT NULL AND (
      parent.id IS NULL OR child.id = parent.id OR child.owner_id <> parent.owner_id
      OR parent.state <> 'superseded'
      OR child.kind <> 'create_task' OR parent.kind <> 'create_task'
      OR child.target_task_id IS NOT NULL OR parent.target_task_id IS NOT NULL
      OR child.expected_state_version IS NOT NULL OR parent.expected_state_version IS NOT NULL
      OR parent.consumed_task_id IS NOT NULL
    )
  ) OR EXISTS (
    SELECT 1 FROM approvals AS parent
    WHERE parent.state = 'superseded'
      AND NOT EXISTS (SELECT 1 FROM approvals AS child WHERE child.supersedes_approval_id = parent.id)
  ) OR EXISTS (
    WITH RECURSIVE chain AS (
      SELECT id, supersedes_approval_id, ARRAY[id] AS path, false AS cycle
      FROM approvals WHERE supersedes_approval_id IS NOT NULL
      UNION ALL
      SELECT parent.id, parent.supersedes_approval_id,
             chain.path || parent.id, parent.id = ANY(chain.path)
      FROM chain JOIN approvals AS parent ON parent.id = chain.supersedes_approval_id
      WHERE NOT chain.cycle
    )
    SELECT 1 FROM chain WHERE cycle
  ) THEN
    RAISE EXCEPTION 'invalid approval successor chain; deployment stopped without repairing history';
  END IF;

  CREATE UNIQUE INDEX approvals_supersedes_approval_id_uniq
    ON approvals (supersedes_approval_id) WHERE supersedes_approval_id IS NOT NULL;

  CREATE TABLE approval_revision_requests (
    owner_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    target_approval_id uuid NOT NULL REFERENCES approvals(id) ON DELETE RESTRICT,
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    anchor_received_at_utc timestamptz NOT NULL DEFAULT clock_timestamp(),
    successor_approval_id uuid UNIQUE REFERENCES approvals(id) ON DELETE RESTRICT,
    PRIMARY KEY (owner_id, idempotency_key),
    CHECK (successor_approval_id IS NULL OR successor_approval_id <> target_approval_id)
  );

  INSERT INTO schema_migrations (version) VALUES ('0013');
END;
$$;

COMMIT;
