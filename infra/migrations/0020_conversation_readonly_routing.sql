-- Publish v5 writers together. Routing facts are internal and never recovery points.
BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='0020') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='0019') THEN
    RAISE EXCEPTION '0019 must be applied before 0020';
  END IF;
ALTER TABLE run_checkpoints DROP CONSTRAINT run_checkpoints_kind_check;
ALTER TABLE run_checkpoints ADD CONSTRAINT run_checkpoints_kind_check CHECK (kind IN (
  'thinking','tool_call','tool_result','approval_required','answer',
  'thread.started','message.delta','card.proposed','thread.completed','thread.failed','thread.cancelled',
  'harness_snapshot','harness_routing_policy','harness_routing_decision','harness_routing_render'
));
CREATE UNIQUE INDEX run_checkpoints_routing_attempt_kind_unique ON run_checkpoints(attempt_id,kind)
  WHERE kind IN ('harness_routing_policy','harness_routing_decision','harness_routing_render');
CREATE FUNCTION run_checkpoints_guard_routing() RETURNS trigger LANGUAGE plpgsql AS $routing$
DECLARE
  accepted record;
  policy_record record;
  decision_record record;
  candidate jsonb;
  source_value jsonb;
  message_text text;
BEGIN
  IF NEW.kind NOT IN ('harness_routing_policy','harness_routing_decision','harness_routing_render') THEN RETURN NEW; END IF;
  SELECT r.*,a.attempt_no,a.status AS attempt_status,a.owner_id AS attempt_owner,
    r.xmin::text AS run_xmin,a.xmin::text AS attempt_xmin INTO accepted
    FROM run_attempts a JOIN agent_runs r ON r.id=a.run_id WHERE a.id=NEW.attempt_id;
  IF NOT FOUND OR accepted.execution<>'harness' OR accepted.attempt_no<>1
    OR accepted.status<>'running' OR accepted.attempt_status<>'running'
    OR accepted.owner_id<>NEW.owner_id OR accepted.attempt_owner<>NEW.owner_id
    OR NEW.stream_protocol_version<>'harness/v5'
    OR jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object'
    OR NEW.payload->>'owner_id' IS DISTINCT FROM NEW.owner_id::text
    OR NEW.payload->>'run_id' IS DISTINCT FROM accepted.id::text
    OR NEW.payload->>'attempt_id' IS DISTINCT FROM NEW.attempt_id::text
    OR NEW.payload->>'message_id' IS DISTINCT FROM accepted.input_message_id::text
    OR EXISTS (SELECT 1 FROM run_attempts WHERE run_id=accepted.id AND attempt_no>1)
    OR NOT EXISTS (SELECT 1 FROM conversations WHERE id=accepted.conversation_id AND owner_id=NEW.owner_id) THEN
    RAISE EXCEPTION 'routing source owner Run and first attempt must match';
  END IF;
  SELECT content INTO message_text FROM messages WHERE id=accepted.input_message_id
    AND owner_id=NEW.owner_id AND conversation_id=accepted.conversation_id AND role='user';
  IF NOT FOUND THEN RAISE EXCEPTION 'routing input message must match'; END IF;
  IF NEW.kind='harness_routing_policy' THEN
    IF accepted.run_xmin<>(txid_current()%4294967296)::text
      OR accepted.attempt_xmin<>(txid_current()%4294967296)::text
      OR NEW.payload->'policy'->>'revision' IS DISTINCT FROM 'r2b/1'
      OR NEW.payload->'policy'->>'mode' IS NULL
      OR NEW.payload->'policy'->>'mode' NOT IN ('off','shadow','enforce') THEN
      RAISE EXCEPTION 'routing policy must be frozen in original admission transaction';
    END IF;
    IF NEW.payload->'policy'->>'mode'='off' THEN
      IF NEW.payload->'policy' IS DISTINCT FROM '{"revision":"r2b/1","mode":"off"}'::jsonb THEN
        RAISE EXCEPTION 'off routing policy has no assets or execution grants';
      END IF;
    ELSIF jsonb_typeof(NEW.payload->'policy'->'candidate_intents') IS DISTINCT FROM 'array'
      OR jsonb_typeof(NEW.payload->'policy'->'direct_intents') IS DISTINCT FROM 'array'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.payload->'policy') AS key)
        IS DISTINCT FROM ARRAY['bundle_sha256','candidate_intents','competition','deadline_ms','direct_intents',
          'encoding_sha256','guard_revision','handler_revision','max_inflight','mode','parser_revision',
          'renderer_revision','revision','scorer_revision','thresholds']
      OR jsonb_typeof(NEW.payload->'policy'->'thresholds') IS DISTINCT FROM 'object'
      OR jsonb_typeof(NEW.payload->'policy'->'competition') IS DISTINCT FROM 'array'
      OR EXISTS (SELECT 1 FROM unnest(ARRAY['guard_revision','parser_revision','handler_revision',
        'renderer_revision','scorer_revision']) AS field
        WHERE jsonb_typeof(NEW.payload->'policy'->field) IS DISTINCT FROM 'string'
          OR length(NEW.payload->'policy'->>field) NOT BETWEEN 1 AND 128)
      OR coalesce(NEW.payload->'policy'->>'bundle_sha256','') !~ '^[0-9a-f]{64}$'
      OR coalesce(NEW.payload->'policy'->>'encoding_sha256','') !~ '^[0-9a-f]{64}$'
      OR NEW.payload->'policy'->>'deadline_ms' IS DISTINCT FROM '1000'
      OR NEW.payload->'policy'->>'max_inflight' IS DISTINCT FROM '2'
      OR (NEW.payload->'policy'->>'mode'='shadow' AND NEW.payload->'policy'->'direct_intents'<>'[]'::jsonb) THEN
      RAISE EXCEPTION 'enabled routing policy must freeze assets grants and budgets';
    END IF;
    RETURN NEW;
  END IF;
  SELECT id,payload INTO policy_record FROM run_checkpoints
    WHERE attempt_id=NEW.attempt_id AND owner_id=NEW.owner_id AND kind='harness_routing_policy';
  IF NOT FOUND OR policy_record.payload->'policy'->>'mode'='off' THEN
    RAISE EXCEPTION 'routing requires enabled admitted policy';
  END IF;
  IF NEW.kind='harness_routing_decision' THEN
    IF NEW.payload->>'policy_ref' IS DISTINCT FROM policy_record.id::text
      OR NEW.payload->'facts'->>'input_sha256' IS DISTINCT FROM encode(sha256(convert_to(message_text,'UTF8')),'hex')
      OR NEW.payload->'facts'->>'bundle_sha256' IS DISTINCT FROM policy_record.payload->'policy'->>'bundle_sha256'
      OR NEW.payload->>'decision' IS NULL OR NEW.payload->>'decision' NOT IN ('direct','fallback')
      OR NEW.payload->>'encoding_count' IS NULL OR NEW.payload->>'encoding_count' NOT IN ('0','1')
      OR jsonb_typeof(NEW.payload->'facts'->'candidates') IS DISTINCT FROM 'array'
      OR jsonb_typeof(NEW.payload->'sources') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'routing decision must bind admitted input policy and evidence';
    END IF;
    IF NEW.payload->'embedding'<>'null'::jsonb AND (
      NEW.payload->'embedding'->>'facts_ref' IS DISTINCT FROM NEW.payload->'facts'->>'facts_ref'
      OR NEW.payload->'embedding'->>'input_sha256' IS DISTINCT FROM NEW.payload->'facts'->>'input_sha256'
      OR NEW.payload->'embedding'->>'bundle_sha256' IS DISTINCT FROM NEW.payload->'facts'->>'bundle_sha256') THEN
      RAISE EXCEPTION 'routing embedding evidence binding mismatch';
    END IF;
    FOR candidate IN SELECT value FROM jsonb_array_elements(NEW.payload->'facts'->'candidates') LOOP
      IF jsonb_typeof(candidate->'sources') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'routing candidate sources required'; END IF;
      IF jsonb_typeof(candidate->'args') IS DISTINCT FROM 'object'
        OR jsonb_array_length(candidate->'sources')<>(SELECT count(*) FROM jsonb_object_keys(candidate->'args'))
        OR jsonb_array_length(candidate->'sources')<>(SELECT count(DISTINCT value->>'field') FROM jsonb_array_elements(candidate->'sources'))
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(candidate->'sources') s WHERE NOT (candidate->'args' ? (s->>'field'))) THEN
        RAISE EXCEPTION 'routing parameters require unique original sources';
      END IF;
      IF candidate->>'intent'='task_list_bounded' THEN
        IF candidate->>'tool_id' IS DISTINCT FROM 'list_tasks'
          OR jsonb_typeof(candidate->'args'->'limit') IS DISTINCT FROM 'number'
          OR (candidate->'args'->>'limit')::numeric NOT BETWEEN 1 AND 50
          OR (candidate->'args'->>'limit')::numeric<>trunc((candidate->'args'->>'limit')::numeric)
          OR EXISTS (SELECT 1 FROM jsonb_object_keys(candidate->'args') k WHERE k NOT IN ('limit','state'))
          OR (candidate->'args' ? 'state' AND candidate->'args'->'state'<>'null'::jsonb) THEN
          RAISE EXCEPTION 'routing task arguments exceed original bounded contract';
        END IF;
      ELSIF candidate->>'intent'='prefs_timezone_read' THEN
        IF candidate->>'tool_id' IS DISTINCT FROM 'get_user_prefs' OR candidate->'args'<>'{}'::jsonb THEN
          RAISE EXCEPTION 'routing prefs cannot accept owner arguments';
        END IF;
      ELSIF candidate->>'intent'='brief_cards_read' THEN
        IF candidate->>'tool_id' IS DISTINCT FROM 'read_brief_cards'
          OR (SELECT count(*) FROM jsonb_object_keys(candidate->'args'))<>1
          OR coalesce(candidate->'args'->>'date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          OR to_char((candidate->'args'->>'date')::date,'YYYY-MM-DD') IS DISTINCT FROM candidate->'args'->>'date' THEN
          RAISE EXCEPTION 'routing brief requires one real Gregorian date';
        END IF;
      ELSE RAISE EXCEPTION 'routing candidate intent invalid';
      END IF;
      FOR source_value IN SELECT value FROM jsonb_array_elements(candidate->'sources') LOOP
        IF source_value->>'parser_revision' IS DISTINCT FROM policy_record.payload->'policy'->>'parser_revision' THEN
          RAISE EXCEPTION 'routing parser binding mismatch';
        END IF;
        IF source_value->>'source'='message' THEN
          IF source_value->>'message_id' IS DISTINCT FROM accepted.input_message_id::text
            OR jsonb_typeof(source_value->'start') IS DISTINCT FROM 'number'
            OR jsonb_typeof(source_value->'end') IS DISTINCT FROM 'number'
            OR jsonb_typeof(source_value->'raw') IS DISTINCT FROM 'string'
            OR source_value->>'field' IS NULL
            OR source_value->>'field' NOT IN ('limit','date')
            OR (source_value->>'start')::int<0 OR (source_value->>'end')::int<(source_value->>'start')::int
            OR source_value->>'raw' IS DISTINCT FROM substring(message_text FROM (source_value->>'start')::int+1 FOR (source_value->>'end')::int-(source_value->>'start')::int)
            OR char_length(source_value->>'raw')<>(source_value->>'end')::int-(source_value->>'start')::int THEN
            RAISE EXCEPTION 'routing message source mismatch';
          END IF;
          IF (source_value->>'field'='date' AND candidate->'args'->>'date' IS DISTINCT FROM source_value->>'raw')
            OR (source_value->>'field'='limit' AND
              (source_value->>'raw' !~ '^[0-9]+$' OR (source_value->>'raw')::numeric IS DISTINCT FROM (candidate->'args'->>'limit')::numeric)) THEN
            RAISE EXCEPTION 'routing parameter value must equal message source';
          END IF;
        ELSIF source_value->>'source'='contract_default' THEN
          IF candidate->>'intent' IS DISTINCT FROM 'task_list_bounded' OR (
            (source_value->>'field'='limit' AND candidate->'args'->'limit'='20'::jsonb) OR
            (source_value->>'field'='state' AND candidate->'args'->'state'='null'::jsonb)) IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'routing contract default source invalid';
          END IF;
        ELSE
          RAISE EXCEPTION 'routing source kind invalid';
        END IF;
      END LOOP;
    END LOOP;
    IF NEW.payload->>'decision'='direct' THEN
      IF policy_record.payload->'policy'->>'mode'<>'enforce'
        OR NOT (policy_record.payload->'policy'->'direct_intents' ? (NEW.payload->>'intent'))
        OR NOT (accepted.tools_allowlist ? (NEW.payload->>'tool_id'))
        OR NEW.payload->'facts'->>'eligible' IS DISTINCT FROM 'true'
        OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.payload->'facts'->'candidates') c
          WHERE c->>'intent'=NEW.payload->>'intent' AND c->>'tool_id'=NEW.payload->>'tool_id'
            AND c->'args'=NEW.payload->'args' AND c->'sources'=NEW.payload->'sources')
        OR NOT ((NEW.payload->>'intent'='task_list_bounded' AND NEW.payload->>'tool_id'='list_tasks')
          OR (NEW.payload->>'intent'='prefs_timezone_read' AND NEW.payload->>'tool_id'='get_user_prefs')
          OR (NEW.payload->>'intent'='brief_cards_read' AND NEW.payload->>'tool_id'='read_brief_cards')) THEN
        RAISE EXCEPTION 'routing direct requires original allowed candidate';
      END IF;
    ELSIF NEW.payload->'intent' IS DISTINCT FROM 'null'::jsonb OR NEW.payload->'tool_id' IS DISTINCT FROM 'null'::jsonb
      OR NEW.payload->'args' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'fallback cannot authorize a tool'; END IF;
    RETURN NEW;
  END IF;
  SELECT id,payload INTO decision_record FROM run_checkpoints
    WHERE attempt_id=NEW.attempt_id AND owner_id=NEW.owner_id AND kind='harness_routing_decision';
  IF NOT FOUND OR decision_record.payload->>'decision'<>'direct'
    OR NEW.payload->>'decision_ref' IS DISTINCT FROM decision_record.id::text
    OR NEW.payload->>'template_revision' IS DISTINCT FROM policy_record.payload->'policy'->>'renderer_revision'
    OR NEW.payload->>'body_sha256' !~ '^[0-9a-f]{64}$'
    OR (NEW.payload->>'chunk_count')::int NOT BETWEEN 1 AND 1024
    OR NOT EXISTS (SELECT 1 FROM tool_invocations i WHERE i.invocation_id::text=NEW.payload->>'invocation_ref'
      AND i.owner_id=NEW.owner_id AND i.run_id=accepted.id AND i.conversation_id=accepted.conversation_id
      AND i.first_attempt_id=NEW.attempt_id AND i.call_key='harness/1' AND i.execution_kind='read_only'
      AND i.tool_id=decision_record.payload->>'tool_id' AND i.args_hash=decision_record.payload->>'args_hash'
      AND i.state='completed' AND i.outcome_kind='success')
    OR (SELECT count(*) FROM tool_invocations WHERE run_id=accepted.id)<>1
    OR NOT EXISTS (SELECT 1 FROM run_checkpoints WHERE attempt_id=NEW.attempt_id AND kind='harness_snapshot'
      AND payload->'tool_refs'=jsonb_build_array(NEW.payload->>'invocation_ref')
      AND payload->'usage'=jsonb_build_object('iterations',0,'tokens',0)) THEN
    RAISE EXCEPTION 'routing render requires real accepted read-only result and zero-model snapshot';
  END IF;
  IF NEW.payload->>'body_sha256' IS DISTINCT FROM (
      SELECT encode(sha256(convert_to(string_agg(payload#>>'{payload,delta}','' ORDER BY seq),'UTF8')),'hex')
      FROM run_checkpoints WHERE attempt_id=NEW.attempt_id AND kind='message.delta')
    OR (NEW.payload->>'chunk_count')::int IS DISTINCT FROM (
      SELECT count(*)::int FROM run_checkpoints WHERE attempt_id=NEW.attempt_id AND kind='message.delta')
    OR EXISTS (SELECT 1 FROM run_checkpoints WHERE attempt_id=NEW.attempt_id AND kind='message.delta'
      AND xmin::text<>(txid_current()%4294967296)::text) THEN
    RAISE EXCEPTION 'routing render must atomically receipt exact accepted display chunks';
  END IF;
  RETURN NEW;
END;
$routing$;
CREATE TRIGGER run_checkpoints_routing_source BEFORE INSERT ON run_checkpoints
  FOR EACH ROW EXECUTE FUNCTION run_checkpoints_guard_routing();
INSERT INTO schema_migrations(version) VALUES('0020');
END;
$migration$;
COMMIT;
