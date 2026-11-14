-- 010_watchdog.sql
-- Watchdog alert log and per-app probe state.

-- ── watchdog_alerts ───────────────────────────────────────────────────────────
-- Stores every alert emitted by the watchdog (proxy probe + abuse metrics).
-- app_id is nullable so org-level / system-level alerts (e.g. metrics_unavailable)
-- are stored without a specific app.  Rows are never deleted automatically.
CREATE TABLE watchdog_alerts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      uuid        REFERENCES apps(id),
  kind        text        NOT NULL,
  detail      jsonb       NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  delivered   boolean     NOT NULL DEFAULT false
);

CREATE INDEX ON watchdog_alerts (app_id, kind, created_at);

-- ── watchdog_probe_state ──────────────────────────────────────────────────────
-- One row per app that has been probed at least once.
-- consecutive_unreachable is reset to 0 when the app becomes healthy again.
CREATE TABLE watchdog_probe_state (
  app_id                   uuid        PRIMARY KEY REFERENCES apps(id),
  consecutive_unreachable  int         NOT NULL DEFAULT 0,
  last_probe_at            timestamptz
);
