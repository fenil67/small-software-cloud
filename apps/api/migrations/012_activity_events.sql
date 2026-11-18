-- Append-only activity event log

-- No FK constraints on audit log — the trigger blocks ON DELETE SET NULL cascades.
-- IDs are stored as plain UUIDs; the audit trail is independent of operational data.
CREATE TABLE activity_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID,
  app_id         UUID,
  event_type     TEXT        NOT NULL,
  actor_type     TEXT        NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system', 'clerk')),
  actor_user_id  UUID,
  actor_key_id   UUID,
  actor_email    TEXT,
  target_id      TEXT,
  ip             INET,
  user_agent     TEXT,
  metadata       JSONB       NOT NULL DEFAULT '{}',
  request_id     TEXT,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX activity_events_occurred_at_id    ON activity_events (occurred_at DESC, id DESC);
CREATE INDEX activity_events_org_id            ON activity_events (org_id, occurred_at DESC);
CREATE INDEX activity_events_app_id            ON activity_events (app_id, occurred_at DESC);
CREATE INDEX activity_events_actor_user_id     ON activity_events (actor_user_id, occurred_at DESC);
CREATE INDEX activity_events_actor_email_lower ON activity_events (lower(actor_email));
CREATE INDEX activity_events_event_type        ON activity_events (event_type, occurred_at DESC);

-- Deduplication index (C3): unique on request_id when present
CREATE UNIQUE INDEX activity_events_request_id_uniq
  ON activity_events (request_id)
  WHERE request_id IS NOT NULL;

-- Append-only trigger (C1 corrected):
-- RETURN NEW for UPDATE (not OLD which would silently cancel the update)
-- RETURN OLD for DELETE
CREATE OR REPLACE FUNCTION activity_events_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('ssc.allow_erase', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'activity_events is append-only';
END;
$$;

CREATE TRIGGER activity_events_immutable_upd
  BEFORE UPDATE ON activity_events
  FOR EACH ROW EXECUTE FUNCTION activity_events_immutable();

CREATE TRIGGER activity_events_immutable_del
  BEFORE DELETE ON activity_events
  FOR EACH ROW EXECUTE FUNCTION activity_events_immutable();

-- Separate TRUNCATE blocker (C1: also block TRUNCATE)
CREATE OR REPLACE FUNCTION activity_events_no_truncate()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'activity_events is append-only: TRUNCATE is not allowed';
END;
$$;

CREATE TRIGGER activity_events_no_truncate
  BEFORE TRUNCATE ON activity_events
  FOR EACH STATEMENT EXECUTE FUNCTION activity_events_no_truncate();

-- redact_email_from_jsonb: replaces JSON string values equal to email with '[redacted]'
CREATE OR REPLACE FUNCTION redact_email_from_jsonb(val JSONB, email TEXT)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result JSONB := '{}';
  k      TEXT;
  v      JSONB;
BEGIN
  FOR k, v IN SELECT * FROM jsonb_each(val) LOOP
    IF jsonb_typeof(v) = 'string' AND lower(v #>> '{}') = lower(email) THEN
      result := result || jsonb_build_object(k, '[redacted]');
    ELSE
      result := result || jsonb_build_object(k, v);
    END IF;
  END LOOP;
  RETURN result;
END;
$$;
