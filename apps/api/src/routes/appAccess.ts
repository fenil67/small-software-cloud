/**
 * GET  /v1/apps/:id/access        → list current users + pending grants
 * POST /v1/apps/:id/access        → grant by email (direct or pending)
 * DELETE /v1/apps/:id/access/:email → revoke access + pending grant
 *
 * Authorization:
 *   - App ID must be a UUID, otherwise 404 immediately (no DB query).
 *   - App must exist, not be deleted, and belong to the caller's org → 404 otherwise.
 *   - Clerk callers must have role "org:admin" → 403 org_admin_required otherwise.
 *   - API keys of the same org are permitted without an admin check.
 */

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireScope } from "../middleware/requireScope";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { ActivityEventType, recordActivityInTx } from "../lib/activityLog";
import { queueInviteEmail } from "../lib/email/outbox";
import { getEmailSender } from "../lib/email/sender";
import { normalizeAppUrl } from "../lib/appUrl";

export const appAccessRouter = Router({ mergeParams: true });
appAccessRouter.use(requireAuth);

// ── Helpers ───────────────────────────────────────────────────────────────────

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// ── Authorization helper ──────────────────────────────────────────────────────

interface AuthResult {
  appId: string;
  /** Internal users.id of the granter; null if unknown or unset. */
  granterId: string | null;
  /** Internal orgs.id; null if unresolved. */
  orgId: string | null;
}

async function authorize(req: Request, res: Response): Promise<AuthResult | null> {
  // Reject non-UUID app IDs before touching the database
  if (!isUuid(req.params.id)) {
    res.status(404).json({ error: "app_not_found" });
    return null;
  }

  const sscAuth = req.sscAuth!;

  // Resolve internal org ID and granter's user ID
  let orgId: string | null = null;
  let granterId: string | null = null;

  if (sscAuth.type === "api_key") {
    orgId = sscAuth.internalOrgId!;
    granterId = sscAuth.apiKeyCreatedBy ?? null;
  } else {
    if (!sscAuth.clerkOrgId) {
      res.status(400).json({ error: "no_active_org" });
      return null;
    }
    const { rows: orgRows } = await pool.query<{ id: string }>(
      "SELECT id FROM orgs WHERE clerk_org_id = $1",
      [sscAuth.clerkOrgId],
    );
    orgId = orgRows[0]?.id ?? null;

    // Look up the Clerk caller's internal user ID (null if not yet in DB)
    if (sscAuth.clerkUserId) {
      const { rows: userRows } = await pool.query<{ id: string }>(
        "SELECT id FROM users WHERE clerk_user_id = $1",
        [sscAuth.clerkUserId],
      );
      granterId = userRows[0]?.id ?? null;
    }
  }

  // App must exist, not be deleted, and belong to the resolved org.
  // Return 404 regardless of the reason (never 403 here — prevents org probing).
  if (!orgId) {
    res.status(404).json({ error: "app_not_found" });
    return null;
  }
  const { rows: appRows } = await pool.query<{ id: string }>(
    "SELECT id FROM apps WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL",
    [req.params.id, orgId],
  );
  if (!appRows[0]) {
    res.status(404).json({ error: "app_not_found" });
    return null;
  }

  // Clerk callers need org:admin role
  if (sscAuth.type === "clerk" && sscAuth.clerkOrgRole !== "org:admin") {
    res.status(403).json({ error: "org_admin_required" });
    return null;
  }

  return { appId: appRows[0].id, granterId, orgId };
}

// ── GET / ─────────────────────────────────────────────────────────────────────

appAccessRouter.get(
  "/",
  requireScope("manage"),
  asyncHandler(async (req: Request, res: Response) => {
    const auth = await authorize(req, res);
    if (!auth) return;
    const { appId } = auth;

    const { rows: users } = await pool.query<{ user_id: string; email: string; granted_at: Date }>(
      `SELECT aa.user_id, u.email, aa.created_at AS granted_at
       FROM app_access aa
       JOIN users u ON u.id = aa.user_id
       WHERE aa.app_id = $1
       ORDER BY aa.created_at`,
      [appId],
    );

    const { rows: pending } = await pool.query<{ email: string; granted_at: Date }>(
      `SELECT email, created_at AS granted_at
       FROM pending_access WHERE app_id = $1 ORDER BY created_at`,
      [appId],
    );

    res.json({ users, pending });
  }),
);

// ── POST / ────────────────────────────────────────────────────────────────────

appAccessRouter.post(
  "/",
  requireScope("manage"),
  asyncHandler(async (req: Request, res: Response) => {
    const auth = await authorize(req, res);
    if (!auth) return;
    const { appId, granterId, orgId } = auth;

    const rawEmail = ((req.body as { email?: string }).email ?? "").trim().toLowerCase();
    if (!rawEmail || rawEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
      res.status(400).json({ error: "validation_error", message: "Invalid email address." });
      return;
    }

    // Fetch granter info (display_name + email) for all actor types
    let granterEmail: string | null = null;
    let granterName = "Someone";
    if (granterId) {
      const { rows: ge } = await pool.query<{ email: string; display_name: string | null }>(
        "SELECT email, display_name FROM users WHERE id = $1", [granterId]);
      if (ge[0]) {
        granterEmail = ge[0].email;
        granterName = ge[0].display_name?.trim() || ge[0].email || "Someone";
      }
    }

    // Fetch app name + subdomain before the transaction
    const { rows: appRows } = await pool.query<{ name: string; subdomain: string | null }>(
      "SELECT name, subdomain FROM apps WHERE id = $1", [appId],
    );
    const appName = appRows[0]?.name ?? "an app";
    const appSubdomain = appRows[0]?.subdomain ?? null;
    const appUrlValue = normalizeAppUrl(appSubdomain);

    // If appUrl is null (not deployed) we still queue — button is omitted in template.
    // If appUrl would be invalid (non-https), do not queue.
    const urlIsValid = appSubdomain === null || (appUrlValue !== null);
    if (!urlIsValid) {
      res.status(201).json({ status: "granted", email_status: "invalid_url" });
      return;
    }

    const emailEnabled = getEmailSender() !== null;
    let emailStatus: string = emailEnabled ? "queued" : "disabled";

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      let shouldQueueEmail = emailEnabled;

      if (emailEnabled) {
        // C3: Check if recipient already has app_access
        const { rows: accessRows } = await client.query(
          `SELECT 1 FROM app_access aa
           JOIN users u ON u.id = aa.user_id
           WHERE aa.app_id = $1 AND lower(u.email) = lower($2)
           LIMIT 1`,
          [appId, rawEmail],
        );
        if (accessRows.length > 0) {
          shouldQueueEmail = false;
          emailStatus = "already_has_access";
        }
      }

      if (emailEnabled && shouldQueueEmail) {
        // C2: Advisory lock on (app_id, lower(email)) to serialize per-recipient rate limit
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext($1 || '|' || lower($2)))`,
          [appId, rawEmail],
        );

        // Per-recipient: max 1 email per app per 24h
        const { rows: recipientRows } = await client.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM email_outbox
           WHERE app_id = $1
             AND lower(to_email) = lower($2)
             AND created_at > now() - INTERVAL '24 hours'`,
          [appId, rawEmail],
        );
        const recipientCount = parseInt(recipientRows[0]?.cnt ?? "0", 10);
        if (recipientCount >= 1) {
          shouldQueueEmail = false;
          emailStatus = "rate_limited_recipient";
        }
      }

      if (emailEnabled && shouldQueueEmail) {
        // C2: Advisory lock on granter id to serialize per-day sender limit
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext($1))`,
          [granterId ?? "anon"],
        );

        // Per-granter: max 50 emails per day
        const { rows: senderRows } = await client.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM email_outbox
           WHERE actor_user_id = $1
             AND created_at > now() - INTERVAL '24 hours'`,
          [granterId],
        );
        const senderCount = parseInt(senderRows[0]?.cnt ?? "0", 10);
        if (senderCount >= 50) {
          shouldQueueEmail = false;
          emailStatus = "rate_limited_sender";
        }
      }

      await client.query(
        `INSERT INTO pending_access (app_id, email, granted_by)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [appId, rawEmail, granterId],
      );

      await recordActivityInTx(client, {
        eventType: ActivityEventType.ACCESS_GRANTED,
        actorType: req.sscAuth!.type === "clerk" ? "user" : "api_key",
        actorUserId: granterId,
        actorEmail: req.sscAuth!.type === "clerk" ? granterEmail : null,
        orgId,
        appId,
        targetId: rawEmail,
        metadata: {},
      });

      if (shouldQueueEmail) {
        const outboxId = await queueInviteEmail(client, {
          toEmail: rawEmail,
          appId,
          actorUserId: granterId,
          granterName,
          granterEmail: granterEmail ?? "",
          appName,
          appUrl: appUrlValue,
        });

        if (outboxId) {
          await recordActivityInTx(client, {
            eventType: ActivityEventType.EMAIL_INVITE_QUEUED,
            actorType: req.sscAuth!.type === "clerk" ? "user" : "api_key",
            actorUserId: granterId,
            actorEmail: req.sscAuth!.type === "clerk" ? granterEmail : null,
            orgId,
            appId,
            targetId: rawEmail,
            metadata: { outbox_id: outboxId },
          });
        } else {
          emailStatus = "disabled"; // queue insert failed
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({ status: "granted", email_status: emailStatus });
  }),
);

// ── DELETE /:email ────────────────────────────────────────────────────────────

appAccessRouter.delete(
  "/:email",
  requireScope("manage"),
  asyncHandler(async (req: Request, res: Response) => {
    const auth = await authorize(req, res);
    if (!auth) return;
    const { appId, granterId } = auth;

    // Express already percent-decodes route params; do NOT call decodeURIComponent again.
    const email = req.params.email.trim().toLowerCase();

    // R4: access.revoked written in same transaction as the deletions.
    let revokerEmail: string | null = null;
    if (req.sscAuth!.type === "clerk" && granterId) {
      const { rows: re } = await pool.query<{ email: string }>(
        "SELECT email FROM users WHERE id = $1", [granterId]);
      revokerEmail = re[0]?.email ?? null;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM app_access
         WHERE app_id = $1
           AND user_id IN (SELECT id FROM users WHERE lower(email) = $2)`,
        [appId, email],
      );
      await client.query(
        "DELETE FROM pending_access WHERE app_id = $1 AND email = $2",
        [appId, email],
      );
      await recordActivityInTx(client, {
        eventType: ActivityEventType.ACCESS_REVOKED,
        actorType: req.sscAuth!.type === "clerk" ? "user" : "api_key",
        actorUserId: granterId,
        actorEmail: req.sscAuth!.type === "clerk" ? revokerEmail : null,
        appId,
        targetId: email,
        metadata: {},
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    res.json({ removed: true });
  }),
);
