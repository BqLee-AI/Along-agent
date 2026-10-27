BEGIN;

ALTER TABLE sessions ADD COLUMN ip_address text NULL;
ALTER TABLE sessions ADD COLUMN user_agent text NULL;

CREATE TABLE installation_admin (
  singleton boolean NOT NULL DEFAULT true,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT installation_admin_pkey PRIMARY KEY (singleton),
  CONSTRAINT installation_admin_singleton_check CHECK (singleton),
  CONSTRAINT installation_admin_user_id_key UNIQUE (user_id),
  CONSTRAINT installation_admin_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

INSERT INTO schema_migrations(version) VALUES ('0017');
COMMIT;
