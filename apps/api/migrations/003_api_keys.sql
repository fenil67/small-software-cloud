CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID        NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_by   UUID        REFERENCES users(id),
  name         TEXT        NOT NULL,
  key_prefix   TEXT        NOT NULL,
  key_hash     TEXT        NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS api_keys_org_id_idx   ON api_keys(org_id);
CREATE INDEX IF NOT EXISTS api_keys_key_hash_idx ON api_keys(key_hash);
