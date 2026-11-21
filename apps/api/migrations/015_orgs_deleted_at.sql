-- Soft-delete column for workspaces (Clerk organisations)
ALTER TABLE orgs ADD COLUMN deleted_at TIMESTAMPTZ;

-- Index for the proxy's "is this org still active?" check
CREATE INDEX orgs_deleted_at ON orgs (deleted_at) WHERE deleted_at IS NOT NULL;
