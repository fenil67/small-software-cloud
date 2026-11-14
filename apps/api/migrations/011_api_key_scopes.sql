-- 011_api_key_scopes.sql
-- Add scopes (required subset of {read,deploy,manage}) and revoked_reason to api_keys.

ALTER TABLE api_keys
  ADD COLUMN scopes       text[] NOT NULL DEFAULT '{read,deploy}',
  ADD COLUMN revoked_reason text;

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_scopes_nonempty_subset CHECK (
    array_length(scopes, 1) > 0
    AND scopes <@ ARRAY['read','deploy','manage']::text[]
  );

-- Existing rows (created before this migration) get full access.
UPDATE api_keys SET scopes = '{read,deploy,manage}';
