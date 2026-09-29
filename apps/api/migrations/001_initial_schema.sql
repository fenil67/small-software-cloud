-- ─── Extensions ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── ENUMS ─────────────────────────────────────────────────────────────────────
CREATE TYPE org_role        AS ENUM ('owner', 'admin', 'member', 'viewer');
CREATE TYPE app_status      AS ENUM ('pending', 'building', 'running', 'stopped', 'failed', 'sleeping');
CREATE TYPE deploy_status   AS ENUM ('queued', 'building', 'deploying', 'success', 'failed', 'cancelled');
CREATE TYPE visibility      AS ENUM ('private', 'team', 'org', 'public');
CREATE TYPE audit_action    AS ENUM (
  'org.created', 'org.updated',
  'app.created', 'app.deleted', 'app.updated',
  'deploy.started', 'deploy.succeeded', 'deploy.failed', 'deploy.rolled_back',
  'permission.granted', 'permission.revoked',
  'user.invited', 'user.removed'
);

-- ─── ORGS ──────────────────────────────────────────────────────────────────────
CREATE TABLE orgs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_org_id  TEXT        NOT NULL UNIQUE,   -- Clerk org ID (org_xxxxx)
  name          TEXT        NOT NULL,
  slug          TEXT        NOT NULL UNIQUE,
  plan          TEXT        NOT NULL DEFAULT 'free',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── USERS ─────────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id   TEXT        NOT NULL UNIQUE,  -- Clerk user ID (user_xxxxx)
  email           TEXT        NOT NULL,
  display_name    TEXT,
  avatar_url      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── ORG_MEMBERS (org ↔ user join + role) ──────────────────────────────────────
CREATE TABLE org_members (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID        NOT NULL REFERENCES orgs(id)  ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       org_role    NOT NULL DEFAULT 'member',
  invited_by UUID        REFERENCES users(id),
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE INDEX org_members_org_id_idx  ON org_members(org_id);
CREATE INDEX org_members_user_id_idx ON org_members(user_id);

-- ─── APPS ──────────────────────────────────────────────────────────────────────
CREATE TABLE apps (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID        NOT NULL REFERENCES orgs(id)  ON DELETE CASCADE,
  owner_id       UUID        NOT NULL REFERENCES users(id),
  name           TEXT        NOT NULL,
  slug           TEXT        NOT NULL,
  description    TEXT,
  status         app_status  NOT NULL DEFAULT 'pending',
  visibility     visibility  NOT NULL DEFAULT 'private',
  -- Fly Machines runtime fields (populated after first deploy)
  fly_app_id     TEXT,
  subdomain      TEXT        UNIQUE,
  -- Source provenance
  source_type    TEXT,        -- 'zip' | 'github' | 'paste' | 'agent_push'
  source_ref     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE INDEX apps_org_id_idx ON apps(org_id);

-- ─── DEPLOYMENTS ───────────────────────────────────────────────────────────────
CREATE TABLE deployments (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          UUID          NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  triggered_by    UUID          REFERENCES users(id),
  version         INTEGER       NOT NULL DEFAULT 1,
  status          deploy_status NOT NULL DEFAULT 'queued',
  -- Fly Machines identifiers
  fly_machine_id  TEXT,
  fly_release_id  TEXT,
  -- Build metadata
  runtime         TEXT,          -- 'node', 'python', 'static', etc.
  build_log_url   TEXT,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  error_message   TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX deployments_app_id_idx ON deployments(app_id);

-- ─── PERMISSIONS ───────────────────────────────────────────────────────────────
-- Fine-grained per-app access grants (supplements org-level roles)
CREATE TABLE permissions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      UUID        NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  -- grantee is either a user or an entire org role (one must be non-null)
  user_id     UUID        REFERENCES users(id) ON DELETE CASCADE,
  role        org_role,   -- grants access to all org members with this role
  granted_by  UUID        REFERENCES users(id),
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT permissions_has_grantee CHECK (
    (user_id IS NOT NULL) OR (role IS NOT NULL)
  )
);

CREATE INDEX permissions_app_id_idx  ON permissions(app_id);
CREATE INDEX permissions_user_id_idx ON permissions(user_id);

-- ─── AUDIT_LOG ─────────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
  id          BIGSERIAL   PRIMARY KEY,
  org_id      UUID        REFERENCES orgs(id),
  actor_id    UUID        REFERENCES users(id),
  action      audit_action NOT NULL,
  resource    TEXT,        -- e.g. 'app:<uuid>' | 'deployment:<uuid>'
  metadata    JSONB,
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Immutable: no UPDATE or DELETE on audit_log rows (enforced at app level;
-- add a rule here if you want DB-level enforcement)
CREATE INDEX audit_log_org_id_idx     ON audit_log(org_id);
CREATE INDEX audit_log_actor_id_idx   ON audit_log(actor_id);
CREATE INDEX audit_log_created_at_idx ON audit_log(created_at DESC);

-- ─── updated_at trigger ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER orgs_updated_at  BEFORE UPDATE ON orgs  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER apps_updated_at  BEFORE UPDATE ON apps  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
