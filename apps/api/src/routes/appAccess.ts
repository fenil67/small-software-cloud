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

    // R4: access.granted written in same transaction as the pending_access insert.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO pending_access (app_id, email, granted_by)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [appId, rawEmail, granterId],
      );
      await recordActivityInTx(client, {
        eventType: ActivityEventType.ACCESS_GRANTED,
        actorType: req.sscAuth!.type === "clerk" ? "user" : "api_key",
        actorUserId: granterId,
        orgId,
        appId,
        targetId: rawEmail,
        metadata: {},
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({ status: "granted" });
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
