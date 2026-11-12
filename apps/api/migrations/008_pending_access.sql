-- 008_pending_access
-- Stores email addresses that have been granted access to an app before the
-- user has registered. When the user signs in, /v1/proxy/codes converts the
-- pending row to a live app_access row.

CREATE TABLE IF NOT EXISTS pending_access (
  app_id     UUID        NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  email      TEXT        NOT NULL,
  granted_by UUID                 REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, email)
);
-- emails are stored lowercased and trimmed by the application layer
