BEGIN;
LOCK TABLE schema_migrations IN EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0038') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0037') THEN
    RAISE EXCEPTION '0037 must be applied before 0038';
  END IF;

  ALTER TABLE model_providers ADD COLUMN default_model_id text;
  UPDATE model_providers AS provider
    SET default_model_id = defaults.model_id
    FROM model_provider_defaults AS defaults
    WHERE provider.id = defaults.provider_id AND provider.owner_id = defaults.owner_id;
  ALTER TABLE model_providers ADD CONSTRAINT model_providers_default_model_fk
    FOREIGN KEY (id, default_model_id) REFERENCES model_provider_models(provider_id, model_id);
  INSERT INTO schema_migrations(version) VALUES ('0038');
END;
$migration$;
COMMIT;
