BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0041') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0040') THEN
    RAISE EXCEPTION '0040 must be applied before 0041';
  END IF;

-- Preserve the historical JSONB limit. The tagged variant has the same logical
-- 1 MiB ceiling, plus 12 nonce bytes, 16 tag bytes and Base64 expansion.
ALTER TABLE compact_continuations
  DROP CONSTRAINT compact_continuations_snapshot_check,
  DROP CONSTRAINT compact_continuations_context_check,
  ADD CONSTRAINT compact_continuations_snapshot_check CHECK (
    CASE WHEN snapshot ? 'encoding' THEN (
      snapshot->>'encoding' = 'feishu-snapshot-aead/1'
      AND jsonb_typeof(snapshot->'ciphertext') = 'string'
      AND snapshot - 'encoding' - 'ciphertext' = '{}'::jsonb
      AND length(snapshot->>'ciphertext') BETWEEN 40 AND 1398140
    ) IS TRUE ELSE octet_length(snapshot::text) <= 1048576 END
  ),
  ADD CONSTRAINT compact_continuations_context_check CHECK (
    CASE WHEN context ? 'encoding' THEN (
      context->>'encoding' = 'feishu-snapshot-aead/1'
      AND jsonb_typeof(context->'ciphertext') = 'string'
      AND context - 'encoding' - 'ciphertext' = '{}'::jsonb
      AND length(context->>'ciphertext') BETWEEN 40 AND 1398140
    ) IS TRUE ELSE octet_length(context::text) <= 1048576 END
  );

-- Keep the old receipt capacity for every other tool and encoding.
ALTER TABLE tool_invocations
  DROP CONSTRAINT tool_invocations_result_check,
  ADD CONSTRAINT tool_invocations_result_check CHECK (
    (state IN ('reserved','unknown') AND outcome_kind IS NULL AND result_version IS NULL
      AND accepted_result IS NULL AND approval_id IS NULL AND accepted_attempt_id IS NULL
      AND accepted_request_id IS NULL AND accepted_at IS NULL AND evidence_ref IS NULL)
    OR (state = 'completed' AND outcome_kind IS NOT NULL AND result_version = 1
      AND accepted_result IS NOT NULL AND jsonb_typeof(accepted_result) = 'object'
      AND octet_length(accepted_result::text) <= CASE
        WHEN tool_id = 'feishu_docx_read' AND outcome_kind = 'success'
          AND accepted_result->>'encoding' = 'feishu-aead/2'
          AND jsonb_typeof(accepted_result->'ciphertext') = 'string'
          AND jsonb_typeof(accepted_result->'keyId') = 'string'
          AND accepted_result - 'encoding' - 'ciphertext' - 'keyId' = '{}'::jsonb
        THEN 321000 ELSE 262144 END
      AND accepted_attempt_id IS NOT NULL AND accepted_request_id IS NOT NULL AND accepted_at IS NOT NULL
      AND ((outcome_kind = 'approval_pending' AND approval_id IS NOT NULL)
        OR (outcome_kind <> 'approval_pending' AND approval_id IS NULL)))
  );

INSERT INTO schema_migrations(version) VALUES ('0041');
END;
$migration$;
COMMIT;
