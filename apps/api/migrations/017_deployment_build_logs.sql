-- deployment_build_logs: full scrubbed build output per deployment.
-- content is capped at ~1 MB by application code before insert.
-- Rows are deleted by the reaper after 30 days.
CREATE TABLE IF NOT EXISTS deployment_build_logs (
  deployment_id UUID        PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
  content       TEXT        NOT NULL,
  truncated     BOOLEAN     NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for the reaper's DELETE WHERE created_at < now() - INTERVAL '30 days'.
CREATE INDEX IF NOT EXISTS deployment_build_logs_created_at_idx
  ON deployment_build_logs(created_at);
