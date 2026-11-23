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
import {
  deleteClerkOrg,
  getClerkOrgDisplayName,
  listOrgMembersAll,
  listOrgInvitationsAll,
  createOrgInvitationClerk,
  revokeOrgInvitationClerk,
  updateOrgMemberRoleClerk,
  removeOrgMemberClerk,
  countOrgAdmins,
} from "../lib/clerkSync";
import { ActivityEventType, recordActivity, recordActivityInTx } from "../lib/activityLog";
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

// ── requireClerkSession: any Clerk session with active org ───────────────────

async function requireClerkSession(
  req: Request,
  res: Response,
): Promise<{ orgId: string; clerkOrgId: string; clerkUserId: string; userId: string | null; email: string | null } | null> {
  const sscAuth = req.sscAuth!;
  if (sscAuth.type !== "clerk") {
    res.status(403).json({ error: "clerk_session_required" });
    return null;
  }
  if (!sscAuth.clerkOrgId || !sscAuth.clerkUserId) {
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

  let userId: string | null = null;
  let email: string | null = null;
  const { rows: userRows } = await pool.query<{ id: string; email: string }>(
    "SELECT id, email FROM users WHERE clerk_user_id = $1",
    [sscAuth.clerkUserId],
  );
  userId = userRows[0]?.id ?? null;
  email = userRows[0]?.email ?? null;

  return { orgId: rows[0].id, clerkOrgId: sscAuth.clerkOrgId, clerkUserId: sscAuth.clerkUserId, userId, email };
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

// ── GET /v1/workspace/members ─────────────────────────────────────────────────

workspaceRouter.get(
  "/members",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = await requireClerkSession(req, res);
    if (!actor) return;
    const { clerkOrgId } = actor;

    let members, invitations;
    try {
      [members, invitations] = await Promise.all([
        listOrgMembersAll(clerkOrgId),
        listOrgInvitationsAll(clerkOrgId),
      ]);
    } catch (err) {
      console.error("[workspace] listOrgMembers failed:", safeErr(err));
      res.status(503).json({ error: "clerk_unavailable" });
      return;
    }

    res.json({ members, invitations });
  }),
);

// ── POST /v1/workspace/invitations ───────────────────────────────────────────

const INVITE_VALID_ROLES = new Set(["org:admin", "org:member"]);
const INVITE_DAILY_LIMIT = 20;

workspaceRouter.post(
  "/invitations",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = await requireClerkAdmin(req, res);
    if (!actor) return;
    const { orgId, clerkOrgId, userId, email: actorEmail } = actor;

    const body = req.body as Record<string, unknown>;
    const inviteEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const inviteRole  = typeof body.role  === "string" ? body.role.trim()              : "org:member";

    if (!inviteEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail)) {
      res.status(400).json({ error: "invalid_email" });
      return;
    }
    if (!INVITE_VALID_ROLES.has(inviteRole)) {
      res.status(400).json({ error: "invalid_role" });
      return;
    }

    // Rate limit: max INVITE_DAILY_LIMIT invitations per org per 24h
    // Uses a Postgres advisory lock to prevent concurrent races.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1 || '|invites'))", [orgId]);

      // Count pending invitations created in the last 24h via the activity log
      const { rows: countRows } = await client.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM activity_events
         WHERE event_type = 'member.invited'
           AND org_id = $1
           AND occurred_at > now() - interval '24 hours'`,
        [orgId],
      );
      const todayCount = parseInt(countRows[0].n, 10);
      if (todayCount >= INVITE_DAILY_LIMIT) {
        await client.query("ROLLBACK");
        res.status(429).json({ error: "invite_rate_limit", limit: INVITE_DAILY_LIMIT });
        return;
      }

      // Check if already a member via Clerk API (before creating)
      let members;
      try {
        members = await listOrgMembersAll(clerkOrgId);
      } catch {
        await client.query("ROLLBACK");
        res.status(503).json({ error: "clerk_unavailable" });
        return;
      }
      if (members.some((m) => m.email.toLowerCase() === inviteEmail)) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "already_member" });
        return;
      }

      // Create the Clerk invitation
      const webUrl = process.env.WEB_URL ?? "";
      const redirectUrl = `${webUrl}/accept-invite?org=${encodeURIComponent(clerkOrgId)}`;
      let invitation: { id: string };
      try {
        invitation = await createOrgInvitationClerk(clerkOrgId, inviteEmail, inviteRole, redirectUrl);
      } catch (err) {
        await client.query("ROLLBACK");
        const axErr = err as { response?: { status?: number; data?: { errors?: Array<{ code?: string }> } } };
        const code = axErr.response?.data?.errors?.[0]?.code ?? "";
        if (code === "already_a_member" || axErr.response?.status === 422) {
          res.status(409).json({ error: "already_member" });
        } else {
          console.error("[workspace] createOrgInvitation failed:", safeErr(err));
          res.status(503).json({ error: "clerk_unavailable" });
        }
        return;
      }

      await recordActivityInTx(client, {
        eventType: ActivityEventType.MEMBER_INVITED,
        actorType: "user",
        actorUserId: userId,
        actorEmail,
        orgId,
        metadata: { invite_id: invitation.id, invitee_email: inviteEmail, role: inviteRole },
      });

      await client.query("COMMIT");
      res.status(201).json({ id: invitation.id, email: inviteEmail, role: inviteRole });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }),
);

// ── POST /v1/workspace/invitations/:id/resend ─────────────────────────────────

workspaceRouter.post(
  "/invitations/:id/resend",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = await requireClerkAdmin(req, res);
    if (!actor) return;
    const { clerkOrgId } = actor;
    const invitationId = req.params.id;

    // Verify invitation belongs to this org
    let invitations;
    try {
      invitations = await listOrgInvitationsAll(clerkOrgId);
    } catch (err) {
      console.error("[workspace] listOrgInvitations failed:", safeErr(err));
      res.status(503).json({ error: "clerk_unavailable" });
      return;
    }
    const invitation = invitations.find((i) => i.id === invitationId);
    if (!invitation) {
      res.status(404).json({ error: "invitation_not_found" });
      return;
    }

    // Revoke and re-create
    const webUrl = process.env.WEB_URL ?? "";
    const redirectUrl = `${webUrl}/accept-invite?org=${encodeURIComponent(clerkOrgId)}`;
    const requestingClerkUserId = req.sscAuth!.clerkUserId ?? null;
    try {
      await revokeOrgInvitationClerk(clerkOrgId, invitationId, requestingClerkUserId);
      const newInv = await createOrgInvitationClerk(
        clerkOrgId,
        invitation.emailAddress,
        invitation.role,
        redirectUrl,
      );
      res.json({ id: newInv.id });
    } catch (err) {
      console.error("[workspace] resend invitation failed:", safeErr(err));
      res.status(503).json({ error: "clerk_unavailable" });
    }
  }),
);

// ── DELETE /v1/workspace/invitations/:id ─────────────────────────────────────

workspaceRouter.delete(
  "/invitations/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = await requireClerkAdmin(req, res);
    if (!actor) return;
    const { orgId, clerkOrgId, userId, email: actorEmail } = actor;
    const invitationId = req.params.id;

    // Verify invitation belongs to this org
    let invitations;
    try {
      invitations = await listOrgInvitationsAll(clerkOrgId);
    } catch (err) {
      console.error("[workspace] listOrgInvitations failed:", safeErr(err));
      res.status(503).json({ error: "clerk_unavailable" });
      return;
    }
    const invitation = invitations.find((i) => i.id === invitationId);
    if (!invitation) {
      res.status(404).json({ error: "invitation_not_found" });
      return;
    }

    const requestingClerkUserId = req.sscAuth!.clerkUserId ?? null;
    try {
      await revokeOrgInvitationClerk(clerkOrgId, invitationId, requestingClerkUserId);
    } catch (err) {
      console.error("[workspace] revokeInvitation failed:", safeErr(err));
      res.status(503).json({ error: "clerk_unavailable" });
      return;
    }

    recordActivity({
      eventType: ActivityEventType.MEMBER_INVITATION_REVOKED,
      actorType: "user",
      actorUserId: userId,
      actorEmail,
      orgId,
      metadata: { invite_id: invitationId, invitee_email: invitation.emailAddress },
    });

    res.json({ revoked: true });
  }),
);

// ── PATCH /v1/workspace/members/:userId ──────────────────────────────────────

workspaceRouter.patch(
  "/members/:userId",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = await requireClerkAdmin(req, res);
    if (!actor) return;
    const { orgId, clerkOrgId, userId: actorUserId, email: actorEmail } = actor;
    const targetClerkUserId = req.params.userId;

    const body = req.body as Record<string, unknown>;
    const newRole = typeof body.role === "string" ? body.role.trim() : "";
    if (!INVITE_VALID_ROLES.has(newRole)) {
      res.status(400).json({ error: "invalid_role" });
      return;
    }

    // Verify target is a member of this org
    let members;
    try {
      members = await listOrgMembersAll(clerkOrgId);
    } catch (err) {
      console.error("[workspace] listOrgMembers failed:", safeErr(err));
      res.status(503).json({ error: "clerk_unavailable" });
      return;
    }
    const targetMember = members.find((m) => m.userId === targetClerkUserId);
    if (!targetMember) {
      res.status(404).json({ error: "member_not_found" });
      return;
    }

    // Last-admin guard: cannot demote the last admin
    if (targetMember.role === "org:admin" && newRole !== "org:admin") {
      const adminCount = members.filter((m) => m.role === "org:admin").length;
      if (adminCount <= 1) {
        res.status(409).json({ error: "last_admin" });
        return;
      }
    }

    try {
      await updateOrgMemberRoleClerk(clerkOrgId, targetClerkUserId, newRole);
    } catch (err) {
      console.error("[workspace] updateMemberRole failed:", safeErr(err));
      res.status(503).json({ error: "clerk_unavailable" });
      return;
    }

    recordActivity({
      eventType: ActivityEventType.MEMBER_ROLE_CHANGED,
      actorType: "user",
      actorUserId,
      actorEmail,
      orgId,
      targetId: targetClerkUserId,
      metadata: { old_role: targetMember.role, new_role: newRole },
    });

    res.json({ updated: true });
  }),
);

// ── DELETE /v1/workspace/members/:userId ─────────────────────────────────────

workspaceRouter.delete(
  "/members/:userId",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = await requireClerkAdmin(req, res);
    if (!actor) return;
    const { orgId, clerkOrgId, userId: actorUserId, email: actorEmail } = actor;
    const targetClerkUserId = req.params.userId;

    // Cannot remove yourself — use /leave for that
    const sscAuth = req.sscAuth!;
    if (sscAuth.clerkUserId === targetClerkUserId) {
      res.status(400).json({ error: "cannot_remove_self" });
      return;
    }

    // Verify target is a member of this org
    let members;
    try {
      members = await listOrgMembersAll(clerkOrgId);
    } catch (err) {
      console.error("[workspace] listOrgMembers failed:", safeErr(err));
      res.status(503).json({ error: "clerk_unavailable" });
      return;
    }
    const targetMember = members.find((m) => m.userId === targetClerkUserId);
    if (!targetMember) {
      res.status(404).json({ error: "member_not_found" });
      return;
    }

    // Last-admin guard
    if (targetMember.role === "org:admin") {
      const adminCount = members.filter((m) => m.role === "org:admin").length;
      if (adminCount <= 1) {
        res.status(409).json({ error: "last_admin" });
        return;
      }
    }

    try {
      await removeOrgMemberClerk(clerkOrgId, targetClerkUserId);
    } catch (err) {
      console.error("[workspace] removeOrgMember failed:", safeErr(err));
      res.status(503).json({ error: "clerk_unavailable" });
      return;
    }

    // Revoke target's API keys and app shares in this org
    await pool.query(
      `UPDATE api_keys SET revoked_at = now()
       WHERE org_id = $1
         AND created_by = (SELECT id FROM users WHERE clerk_user_id = $2)
         AND revoked_at IS NULL`,
      [orgId, targetClerkUserId],
    );
    await pool.query(
      `DELETE FROM app_access
       WHERE user_id = (SELECT id FROM users WHERE clerk_user_id = $1)
         AND app_id IN (SELECT id FROM apps WHERE org_id = $2 AND deleted_at IS NULL)`,
      [targetClerkUserId, orgId],
    );

    recordActivity({
      eventType: ActivityEventType.MEMBER_REMOVED,
      actorType: "user",
      actorUserId,
      actorEmail,
      orgId,
      targetId: targetClerkUserId,
      metadata: { removed_role: targetMember.role },
    });

    res.json({ removed: true });
  }),
);

// ── POST /v1/workspace/leave ──────────────────────────────────────────────────

workspaceRouter.post(
  "/leave",
  asyncHandler(async (req: Request, res: Response) => {
    const actor = await requireClerkSession(req, res);
    if (!actor) return;
    const { orgId, clerkOrgId, clerkUserId, userId, email: actorEmail } = actor;

    // Verify caller is a member (and get their role)
    let members;
    try {
      members = await listOrgMembersAll(clerkOrgId);
    } catch (err) {
      console.error("[workspace] listOrgMembers failed:", safeErr(err));
      res.status(503).json({ error: "clerk_unavailable" });
      return;
    }
    const self = members.find((m) => m.userId === clerkUserId);
    if (!self) {
      res.status(404).json({ error: "member_not_found" });
      return;
    }

    // Last-admin guard
    if (self.role === "org:admin") {
      const adminCount = members.filter((m) => m.role === "org:admin").length;
      if (adminCount <= 1) {
        res.status(409).json({ error: "last_admin" });
        return;
      }
    }

    try {
      await removeOrgMemberClerk(clerkOrgId, clerkUserId);
    } catch (err) {
      console.error("[workspace] leave failed:", safeErr(err));
      res.status(503).json({ error: "clerk_unavailable" });
      return;
    }

    // Revoke own API keys and app shares in this org
    if (userId) {
      await pool.query(
        `UPDATE api_keys SET revoked_at = now()
         WHERE org_id = $1 AND created_by = $2 AND revoked_at IS NULL`,
        [orgId, userId],
      );
      await pool.query(
        `DELETE FROM app_access
         WHERE user_id = $1
           AND app_id IN (SELECT id FROM apps WHERE org_id = $2 AND deleted_at IS NULL)`,
        [userId, orgId],
      );
    }

    recordActivity({
      eventType: ActivityEventType.MEMBER_LEFT,
      actorType: "user",
      actorUserId: userId,
      actorEmail,
      orgId,
      metadata: { left_role: self.role },
    });

    res.json({ left: true });
  }),
);
