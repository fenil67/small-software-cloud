-- Fly apps that deployRunner failed to destroy after all retries.
-- The reaper picks these up and retries; a 404 from Fly counts as success.
-- org_id is informational only — no FK so a deleted org doesn't block cleanup.

CREATE TABLE IF NOT EXISTS orphaned_fly_apps (
  fly_app_name TEXT        PRIMARY KEY,
  org_id       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error   TEXT
);
