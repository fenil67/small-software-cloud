/**
 * /v1/workspace
 *
 * GET  /v1/workspace/delete-preview  — counts of what will be removed
 * DELETE /v1/workspace               — destroy the workspace (org:admin only)
 *
 * Clerk session auth only — no API key path (workspace-level destruction is
 * too broad a scope to expose via API key).
 */

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../lib/asyncHandler";
import { pool } from "../db";
import { deleteWorkspaceData, destroyWorkspaceFlyApps } from "../lib/workspaceDelete";
import { deleteClerkOrg, getClerkOrgDisplayName } from "../lib/clerkSync";
import { safeErr } from "../lib/safeErr";

export const workspaceRouter = Router();
workspaceRouter.use(requireAuth);

// ── helpers ───────────────────────────────────────────────────────────────────

async function requireClerkAdmin(
  req: Request,
  res: Response,
): Promise<{ orgId: string; clerkOrgId: string; userId: string | null; email: string | null } | null> {
  const sscAuth = req.sscAuth!;
  if (sscAuth.type !== "clerk") {
    res.status(403).json({ error: "clerk_session_required" });
    return null;
  }
  if (sscAuth.clerkOrgRole !== "org:admin") {
    res.status(403).json({ error: "org_admin_required" });
    return null;
  }
  if (!sscAuth.clerkOrgId) {
    res.status(400).json({ error: "no_active_org" });
    return null;
  }

  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM orgs WHERE clerk_org_id = $1 AND deleted_at IS NULL",
    [sscAuth.clerkOrgId],
  );
  if (!rows[0]) {
    res.status(404).json({ error: "org_not_found" });
    return null;
  }

  // Resolve actor info for the activity event
  let userId: string | null = null;
  let email: string | null = null;
  if (sscAuth.clerkUserId) {
    const { rows: userRows } = await pool.query<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE clerk_user_id = $1",
      [sscAuth.clerkUserId],
    );
    userId = userRows[0]?.id ?? null;
    email = userRows[0]?.email ?? null;
  }

  return { orgId: rows[0].id, clerkOrgId: sscAuth.clerkOrgId, userId, email };
}

// ── GET /v1/workspace/delete-preview ─────────────────────────────────────────

workspaceRouter.get(
  "/delete-preview",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = await requireClerkAdmin(req, res);
    if (!actor) return;
    const { orgId } = actor;

    const [appsRes, keysRes, invitesRes] = await Promise.all([
      pool.query<{ n: string }>(
        "SELECT COUNT(*) AS n FROM apps WHERE org_id = $1 AND deleted_at IS NULL",
        [orgId],
      ),
      pool.query<{ n: string }>(
        "SELECT COUNT(*) AS n FROM api_keys WHERE org_id = $1 AND revoked_at IS NULL",
        [orgId],
      ),
      pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM email_outbox
         WHERE app_id IN (SELECT id FROM apps WHERE org_id = $1)
           AND status IN ('queued', 'sending')`,
        [orgId],
      ),
    ]);

    res.json({
      apps: parseInt(appsRes.rows[0].n, 10),
      keys: parseInt(keysRes.rows[0].n, 10),
      pending_invites: parseInt(invitesRes.rows[0].n, 10),
    });
  }),
);

// ── DELETE /v1/workspace ──────────────────────────────────────────────────────

workspaceRouter.delete(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = await requireClerkAdmin(req, res);
    if (!actor) return;
    const { orgId, clerkOrgId, userId, email } = actor;

    // Name confirmation: body must include { confirm_name: "<org name>" }
    const body = req.body as Record<string, unknown>;
    const confirmName = typeof body.confirm_name === "string" ? body.confirm_name.trim() : "";

    if (!confirmName) {
      res.status(400).json({ error: "confirm_name_required" });
      return;
    }

    // Fetch the current display name from Clerk (source of truth — avoids stale DB rows)
    const clerkOrgName = await getClerkOrgDisplayName(clerkOrgId);
    if (clerkOrgName === null) {
      res.status(503).json({ error: "clerk_unavailable" });
      return;
    }
    if (clerkOrgName.trim() !== confirmName) {
      res.status(400).json({ error: "name_mismatch" });
      return;
    }

    const result = await deleteWorkspaceData(orgId, { userId, email });

    // Post-commit: destroy Fly machines (failed destroys go to orphaned_fly_apps → reaper)
    destroyWorkspaceFlyApps(result.fly_app_ids, orgId).catch(() => {});

    // Delete the Clerk organization after our DB transaction commits.
    // If Clerk rejects (e.g. already deleted, network error), our data stays deleted —
    // return 200 with clerk_deleted:false so the caller knows and logs it.
    let clerkDeleted = false;
    try {
      await deleteClerkOrg(clerkOrgId);
      clerkDeleted = true;
    } catch (err) {
      // Log the error without secrets (safeErr strips credentials)
      console.error(`[workspace] Clerk org delete failed for org ${orgId.slice(0, 8)}…:`, safeErr(err));
    }

    res.json({
      deleted: true,
      clerk_deleted: clerkDeleted,
      apps_deleted: result.apps_deleted,
      keys_revoked: result.keys_revoked,
      invites_cancelled: result.invites_cancelled,
    });
  }),
);
