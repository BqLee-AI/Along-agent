BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT FROM schema_migrations WHERE version = '0042') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT FROM schema_migrations WHERE version = '0041') THEN
    RAISE EXCEPTION '0041 must be applied before 0042';
  END IF;

-- Acquire the same lock used for the new required column before inspecting the
-- history. An old writer cannot insert between the guard and the cutover.
  LOCK TABLE conversations IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT FROM conversations) THEN
    RAISE EXCEPTION 'personal Bot cutover refused: conversations without a Bot remain';
  END IF;

CREATE FUNCTION personal_bot_config_valid(config jsonb) RETURNS boolean
IMMUTABLE STRICT LANGUAGE plpgsql AS $$
BEGIN
  IF jsonb_typeof(config) <> 'object' THEN RETURN false; END IF;
  IF jsonb_typeof(config->'tool_ids') IS DISTINCT FROM 'array'
    OR jsonb_typeof(config->'workspace_ids') IS DISTINCT FROM 'array'
  THEN RETURN false; END IF;
  RETURN config ?& ARRAY['name','introduction','role','instructions','model_selection','tool_ids','workspace_ids']
    AND config - ARRAY['name','introduction','role','instructions','model_selection','tool_ids','workspace_ids'] = '{}'::jsonb
    AND jsonb_typeof(config->'name') = 'string'
    AND jsonb_typeof(config->'introduction') = 'string'
    AND jsonb_typeof(config->'role') = 'string'
    AND jsonb_typeof(config->'instructions') = 'string'
    AND (
      config->'model_selection' = 'null'::jsonb
      OR (
        jsonb_typeof(config->'model_selection') = 'object'
        AND (config->'model_selection') ?& ARRAY['provider_id','model_id']
        AND (config->'model_selection') - ARRAY['provider_id','model_id'] = '{}'::jsonb
        AND jsonb_typeof(config->'model_selection'->'provider_id') = 'string'
        AND jsonb_typeof(config->'model_selection'->'model_id') = 'string'
      )
    )
    AND NOT EXISTS (SELECT FROM jsonb_array_elements(config->'tool_ids') AS tool(value)
      WHERE jsonb_typeof(value) <> 'string')
    AND NOT EXISTS (SELECT FROM jsonb_array_elements(config->'workspace_ids') AS workspace(value)
      WHERE jsonb_typeof(value) <> 'string'
        OR value = '""'::jsonb);
END;
$$;

CREATE TABLE personal_bots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  config jsonb NOT NULL,
  UNIQUE (owner_id, id),
  CONSTRAINT personal_bot_config_shape CHECK (personal_bot_config_valid(config))
);

ALTER TABLE conversations
  ADD COLUMN bot_id uuid NOT NULL,
  ADD CONSTRAINT conversations_personal_bot_fkey FOREIGN KEY (owner_id, bot_id)
    REFERENCES personal_bots (owner_id, id) ON DELETE RESTRICT;
CREATE INDEX conversations_bot_created_idx ON conversations (owner_id, bot_id, created_at DESC, id DESC);

CREATE FUNCTION conversations_guard_personal_bot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.owner_id, NEW.bot_id) IS DISTINCT FROM (OLD.owner_id, OLD.bot_id) THEN
    RAISE EXCEPTION 'conversation Bot ownership is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversations_personal_bot_immutable BEFORE UPDATE OF owner_id, bot_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_guard_personal_bot();

CREATE TABLE bot_conversation_requests (
  owner_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, idempotency_key)
);
CREATE INDEX bot_conversation_requests_conversation_idx ON bot_conversation_requests (conversation_id);

INSERT INTO schema_migrations (version) VALUES ('0042');
END;
$migration$;

COMMIT;
