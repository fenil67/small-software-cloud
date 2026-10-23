CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id TEXT        NOT NULL UNIQUE,
  email         TEXT        NOT NULL,
  name          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orgs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_org_id TEXT        NOT NULL UNIQUE,
  name         TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS apps (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID        NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  owner_id    UUID        REFERENCES users(id),
  name        TEXT        NOT NULL,
  slug        TEXT        NOT NULL,
  source_type TEXT        NOT NULL,
  source_ref  TEXT,
  fly_app_id  TEXT,
  subdomain   TEXT,
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deployments (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          UUID        NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  triggered_by    UUID        REFERENCES users(id),
  version         INT         NOT NULL DEFAULT 1,
  status          TEXT        NOT NULL DEFAULT 'queued',
  fly_machine_id  TEXT,
  failure_stage   TEXT,
  failure_message TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);
