-- app_access: which users are allowed to access each app via the proxy
CREATE TABLE IF NOT EXISTS app_access (
  app_id     UUID        NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by UUID                 REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, user_id)
);

-- proxy_codes: short-lived one-time codes issued by /v1/proxy/codes
CREATE TABLE IF NOT EXISTS proxy_codes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash   TEXT        NOT NULL UNIQUE,
  app_id      UUID        NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state       TEXT        NOT NULL,
  return_path TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proxy_codes_expires_at_idx ON proxy_codes(expires_at);

-- proxy_credentials: one proxy token per app (upserted on rotation)
CREATE TABLE IF NOT EXISTS proxy_credentials (
  app_id     UUID        PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  token_hash TEXT        NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ
);
