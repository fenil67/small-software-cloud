-- Replace full-table unique constraints with partial unique indexes so that
-- soft-deleted apps no longer hold their slugs or subdomains.

-- Drop the old full-table constraints (IF EXISTS so migration is idempotent)
ALTER TABLE apps DROP CONSTRAINT IF EXISTS apps_org_id_slug_key;
ALTER TABLE apps DROP CONSTRAINT IF EXISTS apps_subdomain_key;

-- Partial unique index: only active (non-deleted) apps occupy a slug per org
CREATE UNIQUE INDEX IF NOT EXISTS apps_org_id_slug_active_key
  ON apps (org_id, slug)
  WHERE deleted_at IS NULL;

-- Partial unique index: only active apps with a subdomain need it to be unique
CREATE UNIQUE INDEX IF NOT EXISTS apps_subdomain_active_key
  ON apps (subdomain)
  WHERE deleted_at IS NULL AND subdomain IS NOT NULL;
