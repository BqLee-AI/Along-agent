BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT FROM schema_migrations WHERE version = '0044') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT FROM schema_migrations WHERE version = '0043') THEN
    RAISE EXCEPTION '0043 must be applied before 0044';
  END IF;

  ALTER TABLE r3_memory_revisions
    ALTER COLUMN conversation_id DROP NOT NULL,
    ADD COLUMN category text,
    DROP CONSTRAINT r3_memory_revisions_message_ids_check,
    DROP CONSTRAINT r3_memory_revisions_source_kind_check,
    ADD CONSTRAINT r3_memory_revisions_message_ids_check CHECK (
      (cardinality(message_ids) = 0) = (source_kind = 'manual')
      AND array_position(message_ids, NULL) IS NULL
    ),
    ADD CONSTRAINT r3_memory_revisions_source_kind_check
      CHECK (source_kind IN ('explicit', 'compact', 'manual')),
    ADD CONSTRAINT r3_memory_revisions_category_check
      CHECK (category IN ('project', 'preference', 'goal')),
    ADD CONSTRAINT r3_memory_revisions_provenance_check CHECK (
      (source_kind = 'manual') = (conversation_id IS NULL)
      AND (source_kind = 'manual') = (category IS NOT NULL)
      AND (source_kind <> 'manual' OR expires_at IS NULL)
    );

  INSERT INTO schema_migrations (version) VALUES ('0044');
END;
$migration$;
COMMIT;
