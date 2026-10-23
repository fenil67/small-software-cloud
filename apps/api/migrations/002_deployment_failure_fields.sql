-- Add structured failure fields to deployments.
--
-- failure_stage:   which pipeline stage failed
--                  (clone | extract | detect | config | fly_app | build | deploy)
-- failure_message: user-safe description; safe to send to clients / stream replay.
--
-- error_message (existing col) continues to store the raw exception message
-- for server-side debugging only — it is never surfaced to clients.

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS failure_stage   TEXT,
  ADD COLUMN IF NOT EXISTS failure_message TEXT;
