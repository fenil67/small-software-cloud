/**
 * Email outbox: queue + sender loop.
 *
 * queueInviteEmail(client, params) — inserts an email_outbox row inside an
 *   existing transaction. Never throws; logs on failure (so the caller's tx
 *   succeeds even if the outbox insert fails).
 *
 * runEmailOutboxSender() — claims queued rows with FOR UPDATE SKIP LOCKED +
 *   lease, sends them, records activity. Called from startReaper().
 *   Skipped when SSC_TEST=1 (tests trigger via /test/run-email-outbox).
 */

import type { PoolClient } from "pg";
import { pool } from "../../db";
import { safeErr } from "../safeErr";
import { buildInviteEmail } from "./template";
import { getEmailSender } from "./sender";
import { ActivityEventType, recordActivity } from "../activityLog";

const BATCH_SIZE = 10;
const LEASE_MINUTES = 2;

/** Backoff schedule: attempts 0–4 → next delay in ms. After attempt 5 → mark failed. */
const BACKOFF_DELAYS_MS = [
  60_000,          // 1 min  (attempt 0 → retry after 1 min)
  5 * 60_000,      // 5 min
  15 * 60_000,     // 15 min
  60 * 60_000,     // 1 hour
  6 * 60 * 60_000, // 6 hours
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface OutboxRow {
  id: string;
  kind: string;
  to_email: string;
  app_id: string | null;
  actor_user_id: string | null;
  attempts: number;
  created_at: Date;
}

interface QueueInviteParams {
  toEmail: string;
  appId: string;
  actorUserId: string | null;
  granterName: string;
  granterEmail: string;
  appName: string;
  appUrl: string | null;
}

// ── Queue ─────────────────────────────────────────────────────────────────────

/**
 * Insert an email_outbox row inside the caller's transaction.
 * Returns the new row's id, or null on insert failure (non-fatal).
 */
export async function queueInviteEmail(
  client: PoolClient,
  params: QueueInviteParams,
): Promise<string | null> {
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO email_outbox
         (kind, to_email, app_id, actor_user_id,
          status, next_attempt_at)
       VALUES ('invite', $1, $2, $3, 'queued', now())
       RETURNING id`,
      [params.toEmail, params.appId, params.actorUserId],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error("[email-outbox] queueInviteEmail failed:", safeErr(err));
    return null;
  }
}

// ── Sender loop ───────────────────────────────────────────────────────────────

export async function runEmailOutboxSender(): Promise<number> {
  const sender = getEmailSender();
  if (!sender) {
    // RESEND_API_KEY not set — skip silently
    return 0;
  }

  // 1. Reset rows whose lease expired (sending → queued)
  await pool.query(
    `UPDATE email_outbox
     SET status = 'queued', lease_until = NULL
     WHERE status = 'sending' AND lease_until < now()`,
  ).catch((err) =>
    console.error("[email-outbox] lease reset failed:", safeErr(err)),
  );

  // 2. Claim a batch with FOR UPDATE SKIP LOCKED
  const { rows } = await pool.query<OutboxRow>(
    `UPDATE email_outbox
     SET status = 'sending',
         lease_until = now() + INTERVAL '${LEASE_MINUTES} minutes'
     WHERE id IN (
       SELECT id FROM email_outbox
       WHERE status = 'queued' AND next_attempt_at <= now()
       ORDER BY next_attempt_at
       LIMIT ${BATCH_SIZE}
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, kind, to_email, app_id, actor_user_id, attempts, created_at`,
  );

  if (rows.length === 0) return 0;

  let sent = 0;

  for (const row of rows) {
    await processRow(row, sender);
    sent++;
  }

  return sent;
}

async function processRow(
  row: OutboxRow,
  sender: ReturnType<typeof getEmailSender>,
): Promise<void> {
  if (!sender) return;

  // Fetch template data
  let granterName = "Someone";
  let granterEmail = "";
  let appName = "an app";
  let appUrl: string | null = null;

  try {
    if (row.actor_user_id) {
      const { rows: uRows } = await pool.query<{ email: string; display_name: string | null }>(
        "SELECT email, display_name FROM users WHERE id = $1",
        [row.actor_user_id],
      );
      if (uRows[0]) {
        granterEmail = uRows[0].email;
        granterName = uRows[0].display_name?.trim() || uRows[0].email || "Someone";
      }
    }

    if (row.app_id) {
      const { rows: aRows } = await pool.query<{ name: string; subdomain: string | null }>(
        "SELECT name, subdomain FROM apps WHERE id = $1",
        [row.app_id],
      );
      if (aRows[0]) {
        appName = aRows[0].name;
        appUrl = aRows[0].subdomain ? `https://${aRows[0].subdomain}` : null;
      }
    }
  } catch (err) {
    console.error(`[email-outbox] data fetch failed for ${row.id}:`, safeErr(err));
  }

  const { subject, html, text } = buildInviteEmail({
    granterName,
    granterEmail,
    appName,
    appUrl,
  });

  try {
    await sender.send({
      to: row.to_email,
      subject,
      html,
      text,
      idempotencyKey: row.id,
      ...(granterEmail ? { replyTo: granterEmail } : {}),
    });

    // Mark sent
    await pool.query(
      `UPDATE email_outbox
       SET status = 'sent', sent_at = now(), lease_until = NULL, attempts = attempts + 1
       WHERE id = $1`,
      [row.id],
    );

    // Fire-and-forget activity log
    recordActivity({
      eventType: ActivityEventType.EMAIL_INVITE_SENT,
      actorType: "system",
      actorUserId: row.actor_user_id,
      appId: row.app_id,
      targetId: row.to_email,
      metadata: { outbox_id: row.id },
    });
  } catch (err) {
    const attempts = row.attempts + 1;
    const errCode = safeErr(err).slice(0, 200);

    if (attempts >= BACKOFF_DELAYS_MS.length + 1) {
      // Final attempt — mark failed
      await pool.query(
        `UPDATE email_outbox
         SET status = 'failed', lease_until = NULL, attempts = $1, last_error_code = $2
         WHERE id = $3`,
        [attempts, errCode, row.id],
      ).catch((e) => console.error("[email-outbox] mark-failed failed:", safeErr(e)));

      recordActivity({
        eventType: ActivityEventType.EMAIL_INVITE_FAILED,
        actorType: "system",
        actorUserId: row.actor_user_id,
        appId: row.app_id,
        targetId: row.to_email,
        metadata: { outbox_id: row.id, error: errCode, attempts },
      });
    } else {
      // Retry with exponential backoff
      const delayMs = BACKOFF_DELAYS_MS[attempts - 1] ?? BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1];
      await pool.query(
        `UPDATE email_outbox
         SET status = 'queued',
             lease_until = NULL,
             attempts = $1,
             last_error_code = $2,
             next_attempt_at = now() + ($3 * INTERVAL '1 millisecond')
         WHERE id = $4`,
        [attempts, errCode, delayMs, row.id],
      ).catch((e) => console.error("[email-outbox] retry-schedule failed:", safeErr(e)));

      console.error(`[email-outbox] send failed (attempt ${attempts}), retry in ${delayMs}ms:`, errCode);
    }
  }
}
