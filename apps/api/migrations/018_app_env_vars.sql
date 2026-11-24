-- Migration 018: per-app environment variable names
-- Stores only names (never values). Values live exclusively in Fly secrets.

CREATE TABLE app_env_vars (
  app_id      UUID        NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (app_id, name)
);

CREATE INDEX app_env_vars_app_id_idx ON app_env_vars(app_id);
