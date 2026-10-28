-- Read-only incremental verifier for the four ordinary indexes added by 0018.
-- The existing 0016/0017 verifiers continue to validate their original objects.
DO $verification$
DECLARE
  expected record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0018') THEN
    RAISE EXCEPTION '0018 migration ledger entry missing';
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('conversations_owner_history_idx', 'conversations',
        ARRAY['owner_id','created_at','id']::text[], ARRAY[0,3,3]::smallint[],
        ARRAY['uuid_ops','timestamptz_ops','uuid_ops']::text[], NULL::text),
      ('messages_owner_conversation_history_idx', 'messages',
        ARRAY['owner_id','conversation_id','created_at','id']::text[], ARRAY[0,0,0,0]::smallint[],
        ARRAY['uuid_ops','uuid_ops','timestamptz_ops','uuid_ops']::text[],
        '(role = ANY (ARRAY[''user''::text, ''assistant''::text]))'::text),
      ('agent_runs_owner_conversation_history_idx', 'agent_runs',
        ARRAY['owner_id','conversation_id','created_at','id']::text[], ARRAY[0,0,0,0]::smallint[],
        ARRAY['uuid_ops','uuid_ops','timestamptz_ops','uuid_ops']::text[], NULL::text),
      ('conversation_idempotency_run_id_idx', 'conversation_idempotency',
        ARRAY['run_id']::text[], ARRAY[0]::smallint[],
        ARRAY['uuid_ops']::text[], NULL::text)
    ) AS indexes(index_name, table_name, columns, options, operator_classes, predicate)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index ix
      JOIN pg_catalog.pg_class idx ON idx.oid = ix.indexrelid
      JOIN pg_catalog.pg_namespace idx_ns ON idx_ns.oid = idx.relnamespace
      JOIN pg_catalog.pg_class tbl ON tbl.oid = ix.indrelid
      JOIN pg_catalog.pg_namespace tbl_ns ON tbl_ns.oid = tbl.relnamespace
      JOIN pg_catalog.pg_am am ON am.oid = idx.relam
      WHERE idx_ns.nspname = 'public' AND idx.relname = expected.index_name
        AND tbl_ns.nspname = 'public' AND tbl.relname = expected.table_name
        AND idx.relkind = 'i' AND tbl.relkind = 'r'
        AND idx.relpersistence = 'p' AND tbl.relpersistence = 'p'
        AND am.amname = 'btree'
        AND ix.indisvalid AND ix.indisready AND ix.indislive
        AND NOT ix.indisunique AND NOT ix.indisprimary AND NOT ix.indisexclusion
        AND ix.indimmediate AND NOT ix.indisreplident AND NOT ix.indnullsnotdistinct
        AND ix.indnkeyatts = cardinality(expected.columns)
        AND ix.indnatts = cardinality(expected.columns)
        AND ix.indexprs IS NULL
        AND pg_catalog.pg_get_expr(ix.indpred, ix.indrelid) IS NOT DISTINCT FROM expected.predicate
        AND ARRAY(
          SELECT attr.attname::text
          FROM unnest(ix.indkey) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_catalog.pg_attribute attr ON attr.attrelid = tbl.oid AND attr.attnum = key.attnum
          WHERE NOT attr.attisdropped ORDER BY key.position
        ) = expected.columns
        -- indoption stores ASC/DESC and NULLS FIRST/LAST for each key.
        AND ARRAY(
          SELECT option FROM unnest(ix.indoption) WITH ORDINALITY AS opts(option, position)
          ORDER BY position
        ) = expected.options
        AND ARRAY(
          SELECT opc.opcname::text
          FROM unnest(ix.indclass) WITH ORDINALITY AS classes(opcoid, position)
          JOIN pg_catalog.pg_opclass opc ON opc.oid = classes.opcoid
          JOIN pg_catalog.pg_namespace opc_ns ON opc_ns.oid = opc.opcnamespace
          WHERE opc_ns.nspname = 'pg_catalog' AND opc.opcdefault AND opc.opcmethod = am.oid
          ORDER BY classes.position
        ) = expected.operator_classes
        AND ARRAY(
          SELECT coll_oid FROM unnest(ix.indcollation) WITH ORDINALITY AS collations(coll_oid, position)
          ORDER BY position
        ) = ARRAY(
          SELECT attr.attcollation
          FROM unnest(ix.indkey) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_catalog.pg_attribute attr ON attr.attrelid = tbl.oid AND attr.attnum = key.attnum
          ORDER BY key.position
        )
    ) THEN
      RAISE EXCEPTION '0018 index structure mismatch: %', expected.index_name;
    END IF;
  END LOOP;
END;
$verification$;
