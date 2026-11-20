-- Performance index for GET /v1/me/shared-apps (user_id lookup on app_access)
CREATE INDEX IF NOT EXISTS app_access_user_id_idx ON app_access(user_id);
