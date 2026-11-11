BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0028') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0027') THEN
    RAISE EXCEPTION '0027 must be applied before 0028';
  END IF;

CREATE TABLE model_providers (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  current_version_id uuid NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_id)
);
CREATE INDEX model_providers_owner_idx ON model_providers(owner_id) WHERE deleted_at IS NULL;

CREATE TABLE model_provider_versions (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  base_url text NOT NULL DEFAULT '',
  credential_ciphertext text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_id, provider_id),
  FOREIGN KEY (provider_id, owner_id) REFERENCES model_providers(id, owner_id)
);
ALTER TABLE model_providers ADD CONSTRAINT model_provider_current_version_fk
  FOREIGN KEY (current_version_id, owner_id, id)
  REFERENCES model_provider_versions(id, owner_id, provider_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE model_provider_models (
  provider_id uuid NOT NULL REFERENCES model_providers(id),
  model_id text NOT NULL,
  PRIMARY KEY (provider_id, model_id)
);
CREATE TABLE model_provider_defaults (
  owner_id uuid PRIMARY KEY,
  provider_id uuid NOT NULL,
  model_id text NOT NULL,
  FOREIGN KEY (provider_id, owner_id) REFERENCES model_providers(id, owner_id),
  FOREIGN KEY (provider_id, model_id) REFERENCES model_provider_models(provider_id, model_id)
);
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_id_owner_unique UNIQUE (id, owner_id);
CREATE TABLE model_provider_run_bindings (
  run_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  version_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  provider_name text NOT NULL,
  model_id text NOT NULL,
  FOREIGN KEY (version_id, owner_id, provider_id)
    REFERENCES model_provider_versions(id, owner_id, provider_id),
  FOREIGN KEY (run_id, owner_id) REFERENCES agent_runs(id, owner_id)
);
CREATE FUNCTION model_provider_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'model provider run binding is immutable';
END;
$$;
CREATE TRIGGER model_provider_binding_no_mutation BEFORE UPDATE OR DELETE ON model_provider_run_bindings
  FOR EACH ROW EXECUTE FUNCTION model_provider_binding_immutable();
INSERT INTO schema_migrations(version) VALUES ('0028');
END;
$migration$;
COMMIT;
