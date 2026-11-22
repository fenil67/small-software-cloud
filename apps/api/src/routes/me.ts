/**
 * GET /v1/me        → { is_admin: boolean, open_alert_count: number | null }
 * GET /v1/me/shared-apps → SharedApp[]
 *
 * Auth: Clerk session only. API key → 403.
 */

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../lib/asyncHandler";
import { pool } from "../db";
import { isAdminId } from "./admin";
import { normalizeAppUrl } from "../lib/appUrl";
import { getUserOrgIds, deleteClerkUser, deleteClerkOrg } from "../lib/clerkSync";
import { deleteWorkspaceData, destroyWorkspaceFlyApps } from "../lib/workspaceDelete";
import { deleteUserData } from "../lib/userDelete";
import { safeErr } from "../lib/safeErr";

export const meRouter = Router();
meRouter.use(requireAuth);

// ── GET /v1/me ────────────────────────────────────────────────────────────────

meRouter.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    if (req.sscAuth?.type !== "clerk") {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const clerkUserId = req.sscAuth.clerkUserId!;
    const is_admin = isAdminId(clerkUserId);

    let open_alert_count: number | null = null;
    if (is_admin) {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM watchdog_alerts WHERE created_at > now() - INTERVAL '7 days'`,
      );
      open_alert_count = rows[0]?.n ?? 0;
    }

    res.json({ is_admin, open_alert_count });
  }),
);

// ── GET /v1/me/shared-apps ────────────────────────────────────────────────────

interface SharedAppRow {
  app_id: string;
  app_name: string;
  url: string | null;
  org_name: string;
  granted_at: Date | null;
  status: string;
}

meRouter.get(
  "/shared-apps",
  asyncHandler(async (req: Request, res: Response) => {
    if (req.sscAuth?.type !== "clerk") {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const clerkUserId = req.sscAuth.clerkUserId!;

    // Look up internal user
    const { rows: userRows } = await pool.query<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE clerk_user_id = $1 LIMIT 1",
      [clerkUserId],
    );

    if (!userRows[0]) {
      res.json([]);
      return;
    }

    const internalUserId = userRows[0].id;
    const userEmail = userRows[0].email;

    // Fetch all Clerk org memberships for this user so we can exclude apps from
    // orgs the user already belongs to (they appear in "Your apps", not "Shared with you").
    const memberClerkOrgIds = await getUserOrgIds(clerkUserId);
    if (memberClerkOrgIds === null) {
      res.status(503).json({ error: "clerk_unavailable" });
      return;
    }

    // Also fold in the active org (always a member org; Clerk stubs in tests may not list it).
    const clerkOrgId = req.sscAuth!.clerkOrgId;
    const allMemberClerkIds = clerkOrgId
      ? Array.from(new Set([...memberClerkOrgIds, clerkOrgId]))
      : memberClerkOrgIds;

    // Resolve Clerk org IDs → internal UUIDs
    let memberInternalOrgIds: string[] = [];
    if (allMemberClerkIds.length > 0) {
      const { rows: memberOrgRows } = await pool.query<{ id: string }>(
        "SELECT id FROM orgs WHERE clerk_org_id = ANY($1::text[]) AND deleted_at IS NULL",
        [allMemberClerkIds],
      );
      memberInternalOrgIds = memberOrgRows.map((r) => r.id);
    }

    // Build the exclusion clause: use array parameter when we have orgs to exclude
    const orgFilter = memberInternalOrgIds.length > 0 ? "AND a.org_id != ALL($3::uuid[])" : "";
    const queryParams: unknown[] = memberInternalOrgIds.length > 0
      ? [internalUserId, userEmail, memberInternalOrgIds]
      : [internalUserId, userEmail];

    const { rows } = await pool.query<SharedAppRow>(`
      SELECT
        a.id        AS app_id,
        a.name      AS app_name,
        a.subdomain AS url,
        o.name      AS org_name,
        aa.created_at AS granted_at,
        'active'    AS status
      FROM app_access aa
      JOIN apps a ON a.id = aa.app_id AND a.deleted_at IS NULL
      JOIN orgs o ON o.id = a.org_id AND o.deleted_at IS NULL
      WHERE aa.user_id = $1
        ${orgFilter}

      UNION ALL

      SELECT
        a.id        AS app_id,
        a.name      AS app_name,
        a.subdomain AS url,
        o.name      AS org_name,
        pa.created_at AS granted_at,
        'pending'   AS status
      FROM pending_access pa
      JOIN apps a ON a.id = pa.app_id AND a.deleted_at IS NULL
      JOIN orgs o ON o.id = a.org_id AND o.deleted_at IS NULL
      WHERE lower(pa.email) = lower($2)
        AND NOT EXISTS (
          SELECT 1 FROM app_access aa2
          WHERE aa2.app_id = pa.app_id AND aa2.user_id = $1
        )
        ${orgFilter}

      ORDER BY granted_at DESC NULLS LAST
    `, queryParams);

    const result = rows.map((r) => ({
      app_id: r.app_id,
      app_name: r.app_name,
      url: normalizeAppUrl(r.url),
      org_name: r.org_name,
      granted_at: r.granted_at ? r.granted_at.toISOString() : null,
      status: r.status as "active" | "pending",
    }));

    res.json(result);
  }),
);

// ── DELETE /v1/me ─────────────────────────────────────────────────────────────
//
// Deletes the authenticated user's account.
//
// Auth: Clerk session only. API key → 403 (clerk_session_required).
// Body: { confirm_email: string }  — must equal the user's primary email (else 400).
//
// Safety checks (all checked before any mutation):
//   - User is sole admin of a workspace that has other members → 409 with workspace list.
//     The user must make someone else admin first.
//
// Cleanup order:
//   1. For each workspace where this user is the ONLY member:
//      deleteWorkspaceData + deleteClerkOrg (async Fly cleanup post-commit).
//   2. deleteUserData (revoke API keys, null FKs, delete user row + activity event).
//   3. Delete Clerk user via backend API.
// Returns 200.  Web must sign out and redirect to /sign-in.

meRouter.delete(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    if (req.sscAuth?.type !== "clerk") {
      res.status(403).json({ error: "clerk_session_required" });
      return;
    }

    const clerkUserId = req.sscAuth.clerkUserId!;

    // Look up internal user record
    const { rows: userRows } = await pool.query<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE clerk_user_id = $1 LIMIT 1",
      [clerkUserId],
    );
    if (!userRows[0]) {
      res.status(404).json({ error: "user_not_found" });
      return;
    }
    const internalUserId = userRows[0].id;
    const userEmail = userRows[0].email;

    // Confirm email must match
    const body = req.body as Record<string, unknown>;
    const confirmEmail = typeof body.confirm_email === "string" ? body.confirm_email.trim().toLowerCase() : "";
    if (!confirmEmail || confirmEmail !== userEmail.toLowerCase()) {
      res.status(400).json({ error: "email_mismatch" });
      return;
    }

    // ── Safety check: sole-admin-with-other-members → 409 ──────────────────
    // A workspace is blocked if this user is the only admin/owner AND other
    // members exist.  We block before touching anything.
    const { rows: blockedOrgs } = await pool.query<{ id: string; name: string }>(
      `SELECT o.id, o.name
       FROM orgs o
       WHERE o.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM org_members om
           WHERE om.org_id = o.id AND om.user_id = $1 AND om.role IN ('owner', 'admin')
         )
         AND EXISTS (
           SELECT 1 FROM org_members om2
           WHERE om2.org_id = o.id AND om2.user_id != $1
         )
         AND NOT EXISTS (
           SELECT 1 FROM org_members om3
           WHERE om3.org_id = o.id AND om3.user_id != $1 AND om3.role IN ('owner', 'admin')
         )`,
      [internalUserId],
    );
    if (blockedOrgs.length > 0) {
      res.status(409).json({
        error: "sole_admin_blocked",
        message: "You are the only admin of one or more workspaces that have other members. Make someone else admin first.",
        workspaces: blockedOrgs.map((o) => ({ id: o.id, name: o.name })),
      });
      return;
    }

    // ── Find sole-member workspaces to delete ──────────────────────────────
    const { rows: soleOrgs } = await pool.query<{ id: string; clerk_org_id: string }>(
      `SELECT o.id, o.clerk_org_id
       FROM orgs o
       WHERE o.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM org_members om WHERE om.org_id = o.id AND om.user_id = $1
         )
         AND NOT EXISTS (
           SELECT 1 FROM org_members om2 WHERE om2.org_id = o.id AND om2.user_id != $1
         )`,
      [internalUserId],
    );

    // ── Clean sole-member workspaces ──────────────────────────────────────
    const flyAppIds: Array<{ ids: string[]; orgId: string }> = [];
    for (const org of soleOrgs) {
      const result = await deleteWorkspaceData(org.id, {
        userId: internalUserId,
        email: userEmail,
        requestId: `workspace.deleted:${org.id}`,
      });
      flyAppIds.push({ ids: result.fly_app_ids, orgId: org.id });

      // Best-effort: delete the Clerk org.  Failure does not abort user deletion.
      try {
        await deleteClerkOrg(org.clerk_org_id);
      } catch (err) {
        console.error(`[me] Clerk org delete failed for org ${org.id.slice(0, 8)}…:`, safeErr(err));
      }
    }

    // Post-commit Fly cleanup (fire-and-forget, never throws)
    for (const { ids, orgId } of flyAppIds) {
      destroyWorkspaceFlyApps(ids, orgId).catch(() => {});
    }

    // ── Delete user data (keys, FK nulls, user row, activity event) ────────
    await deleteUserData(internalUserId, {
      clerkUserId,
      email: userEmail,
      requestId: `user.account_deleted:${internalUserId}`,
    });

    // ── Delete Clerk user via backend API ───────────────────────────────────
    let clerkDeleted = false;
    try {
      await deleteClerkUser(clerkUserId);
      clerkDeleted = true;
    } catch (err) {
      console.error(`[me] Clerk user delete failed for ${clerkUserId.slice(0, 8)}…:`, safeErr(err));
    }

    res.json({ deleted: true, clerk_deleted: clerkDeleted });
  }),
);
