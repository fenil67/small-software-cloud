-- Email outbox: reliable async email delivery with lease-based claiming
CREATE TABLE IF NOT EXISTS email_outbox (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT        NOT NULL DEFAULT 'invite',
  to_email        TEXT        NOT NULL,
  app_id          UUID,
  actor_user_id   UUID,
  status          TEXT        NOT NULL DEFAULT 'queued'
                              CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempts        INT         NOT NULL DEFAULT 0,
  lease_until     TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error_code TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ
);

-- Index for the sending loop: pick up queued rows due for delivery
CREATE INDEX IF NOT EXISTS email_outbox_status_next_idx
  ON email_outbox (status, next_attempt_at)
  WHERE status = 'queued';

-- Index for the lease-reset query: find sending rows with expired leases
CREATE INDEX IF NOT EXISTS email_outbox_lease_reset_idx
  ON email_outbox (status, lease_until)
  WHERE status = 'sending';

-- Index for per-recipient rate-limit check inside the grant transaction
CREATE INDEX IF NOT EXISTS email_outbox_to_email_app_idx
  ON email_outbox (lower(to_email), app_id, created_at);

-- Index for erase-by-actor and daily-sender rate-limit check
CREATE INDEX IF NOT EXISTS email_outbox_actor_created_idx
  ON email_outbox (actor_user_id, created_at);
