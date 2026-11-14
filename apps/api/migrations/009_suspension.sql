-- 009_suspension.sql
-- Adds per-app suspension state and an admin audit log.

-- ── apps table additions ──────────────────────────────────────────────────────
ALTER TABLE apps
  ADD COLUMN suspended_at   timestamptz,
  ADD COLUMN suspended_by   uuid REFERENCES users(id),
  ADD COLUMN suspend_reason text;

-- ── admin audit log ───────────────────────────────────────────────────────────
-- Rows are never deleted (no ON DELETE CASCADE) because apps are soft-deleted
-- (deleted_at) and audit history must be preserved.
CREATE TABLE admin_audit (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  action               text        NOT NULL
                                   CHECK (action IN ('suspend', 'unsuspend')),
  app_id               uuid        NOT NULL REFERENCES apps(id),
  actor_user_id        uuid        REFERENCES users(id),
  actor_clerk_user_id  text        NOT NULL,
  reason               text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
