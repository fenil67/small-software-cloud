/**
 * POST /v1/webhooks/clerk
 *
 * Receives Clerk webhook events and acts on membership/user lifecycle changes.
 *
 * Security: svix HMAC-SHA256 signature verification.
 *   payload  = "<svix-id>.<svix-timestamp>.<rawBody>"
 *   secret   = base64-decode(CLERK_WEBHOOK_SIGNING_SECRET after stripping "whsec_" prefix)
 *   compare  = timingSafeEqual(computed, one of the v1,<sig> values in svix-signature)
 *   window   = ±5 minutes
 *
 * Events handled:
 *   organizationMembership.deleted → revoke all active keys whose created_by left the org
 *   user.deleted                   → full DB teardown: revoke keys, NULL owner_id on
 *                                    surviving apps, delete sole-member workspaces, delete
 *                                    users row (safe if already cleaned by DELETE /v1/me)
 */

import { Router, Request, Response } from "express";
import express from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { pool } from "../db";
import { ActivityEventType, recordActivity } from "../lib/activityLog";
import { deleteWorkspaceData, destroyWorkspaceFlyApps } from "../lib/workspaceDelete";
import { deleteUserData } from "../lib/userDelete";

export const webhookRouter = Router();

// Raw body is required for signature verification — mount this BEFORE express.json().
// express.raw() captures the body as Buffer; subsequent express.json() sees req.body
// already set and skips parsing for this request.
webhookRouter.use(express.raw({ type: "application/json" }));

// ─── Signature verification ───────────────────────────────────────────────────

export function verifyClerkWebhookSignature(
  rawBody: Buffer,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
  secret: string,
): boolean {
  // Decode the whsec_ secret
  const secretBytes = Buffer.from(secret.slice("whsec_".length), "base64");

  // Check timestamp is within ±5 minutes
  const ts = parseInt(svixTimestamp, 10);
  if (isNaN(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > 5 * 60) return false;

  // Compute expected signature
  const signedPayload = `${svixId}.${svixTimestamp}.${rawBody.toString("utf8")}`;
  const computed = createHmac("sha256", secretBytes)
    .update(signedPayload)
    .digest();

  // svix-signature header may contain multiple space-separated "v1,<base64>" values
  const candidates = svixSignature.split(" ");
  for (const candidate of candidates) {
    if (!candidate.startsWith("v1,")) continue;
    const sigBytes = Buffer.from(candidate.slice("v1,".length), "base64");
    if (sigBytes.length === computed.length && timingSafeEqual(computed, sigBytes)) {
      return true;
    }
  }
  return false;
}

// ─── Route ────────────────────────────────────────────────────────────────────

webhookRouter.post("/clerk", async (req: Request, res: Response): Promise<void> => {
  const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  if (!secret) {
    res.status(503).json({ error: "webhook_not_configured" });
    return;
  }

  const svixId        = req.headers["svix-id"] as string | undefined;
  const svixTimestamp = req.headers["svix-timestamp"] as string | undefined;
  const svixSignature = req.headers["svix-signature"] as string | undefined;

  if (!svixId || !svixTimestamp || !svixSignature) {
    res.status(400).json({ error: "missing_svix_headers" });
    return;
  }

  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody)) {
    res.status(400).json({ error: "unexpected_body_type" });
    return;
  }

  if (!verifyClerkWebhookSignature(rawBody, svixId, svixTimestamp, svixSignature, secret)) {
    res.status(401).json({ error: "invalid_signature" });
    return;
  }

  let event: { type: string; data: Record<string, unknown> };
  try {
    event = JSON.parse(rawBody.toString("utf8")) as typeof event;
  } catch {
    res.status(400).json({ error: "invalid_json" });
    return;
  }

  try {
    if (event.type === "organizationMembership.deleted") {
      // data.public_user_data.user_id  — the user who left
      // data.organization.id           — the org they left
      const userId  = (event.data.public_user_data as Record<string, string> | undefined)?.user_id;
      const clerkOrgId = (event.data.organization as Record<string, string> | undefined)?.id;

      if (userId && clerkOrgId) {
        await revokeKeysByCreator(userId, clerkOrgId, "creator_left_org");
      }
      recordActivity({
        eventType: ActivityEventType.CLERK_MEMBERSHIP_DELETED,
        actorType: "clerk",
        requestId: svixId,
        metadata: {
          clerk_user_id: userId ?? "",
          clerk_org_id: clerkOrgId ?? "",
        },
      });
    } else if (event.type === "user.deleted") {
      // data.id — the deleted user's Clerk ID
      const clerkUserId = event.data.id as string | undefined;
      if (clerkUserId) {
        // Always revoke keys immediately — safe even when the users row is already gone
        // (e.g. DELETE /v1/me ran first).  Keeps revoked_reason = 'creator_deleted'.
        await revokeKeysByCreatorAllOrgs(clerkUserId, "creator_deleted");

        // Look up our internal user record.  May be absent if DELETE /v1/me already
        // cleaned up (the revoke above is then a no-op).
        const { rows: wuRows } = await pool.query<{ id: string }>(
          "SELECT id FROM users WHERE clerk_user_id = $1 LIMIT 1",
          [clerkUserId],
        );
        if (wuRows[0]) {
          const internalUserId = wuRows[0].id;

          // Tear down sole-member workspaces (orgs where this is the only member).
          const { rows: wuSoleOrgs } = await pool.query<{ id: string }>(
            `SELECT o.id FROM orgs o
             WHERE o.deleted_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM org_members om WHERE om.org_id = o.id AND om.user_id = $1
               )
               AND NOT EXISTS (
                 SELECT 1 FROM org_members om2 WHERE om2.org_id = o.id AND om2.user_id != $1
               )`,
            [internalUserId],
          );
          for (const org of wuSoleOrgs) {
            const result = await deleteWorkspaceData(org.id, { requestId: svixId ?? undefined });
            destroyWorkspaceFlyApps(result.fly_app_ids, org.id).catch(() => {});
          }

          // deleteUserData: NULLs owner_id (+ other nullable FKs) then deletes users row.
          // Keys are already revoked above; deleteUserData skips them (revoked_at IS NOT NULL).
          await deleteUserData(internalUserId, {
            clerkUserId,
            requestId: `clerk.user_deleted:${svixId ?? internalUserId}`,
          });
        }
      }
      recordActivity({
        eventType: ActivityEventType.CLERK_USER_DELETED,
        actorType: "clerk",
        requestId: svixId,
        metadata: { clerk_user_id: clerkUserId ?? "" },
      });
    } else if (event.type === "user.created") {
      const userId = event.data.id as string | undefined;
      recordActivity({
        eventType: ActivityEventType.CLERK_USER_CREATED,
        actorType: "clerk",
        requestId: svixId,
        metadata: { clerk_user_id: userId ?? "" },
      });
    } else if (event.type === "user.updated") {
      const userId = event.data.id as string | undefined;
      recordActivity({
        eventType: ActivityEventType.CLERK_USER_UPDATED,
        actorType: "clerk",
        requestId: svixId,
        metadata: { clerk_user_id: userId ?? "" },
      });
    } else if (event.type === "organization.created") {
      const orgId = event.data.id as string | undefined;
      recordActivity({
        eventType: ActivityEventType.CLERK_ORG_CREATED,
        actorType: "clerk",
        requestId: svixId,
        metadata: { clerk_org_id: orgId ?? "" },
      });
    } else if (event.type === "organization.updated") {
      const orgId = event.data.id as string | undefined;
      recordActivity({
        eventType: ActivityEventType.CLERK_ORG_UPDATED,
        actorType: "clerk",
        requestId: svixId,
        metadata: { clerk_org_id: orgId ?? "" },
      });
    } else if (event.type === "organization.deleted") {
      const clerkOrgId = event.data.id as string | undefined;
      // Run workspace teardown for the deleted org (deduped by svixId requestId)
      if (clerkOrgId) {
        const { rows: orgRows } = await pool.query<{ id: string }>(
          "SELECT id FROM orgs WHERE clerk_org_id = $1",
          [clerkOrgId],
        );
        if (orgRows[0]) {
          const result = await deleteWorkspaceData(orgRows[0].id, { requestId: svixId });
          // Post-commit Fly cleanup — failures go to orphaned_fly_apps → reaper
          destroyWorkspaceFlyApps(result.fly_app_ids, orgRows[0].id).catch(() => {});
        }
      }
      recordActivity({
        eventType: ActivityEventType.CLERK_ORG_DELETED,
        actorType: "clerk",
        requestId: svixId ? `clerk.org_deleted:${svixId}` : null,
        metadata: { clerk_org_id: clerkOrgId ?? "" },
      });
    } else if (event.type === "organizationMembership.created") {
      const userId = (event.data.public_user_data as Record<string, string> | undefined)?.user_id;
      const orgId  = (event.data.organization as Record<string, string> | undefined)?.id;
      recordActivity({
        eventType: ActivityEventType.CLERK_MEMBERSHIP_CREATED,
        actorType: "clerk",
        requestId: svixId,
        metadata: { clerk_user_id: userId ?? "", clerk_org_id: orgId ?? "" },
      });
    } else if (event.type === "organizationMembership.updated") {
      const userId = (event.data.public_user_data as Record<string, string> | undefined)?.user_id;
      const orgId  = (event.data.organization as Record<string, string> | undefined)?.id;
      recordActivity({
        eventType: ActivityEventType.CLERK_MEMBERSHIP_UPDATED,
        actorType: "clerk",
        requestId: svixId,
        metadata: { clerk_user_id: userId ?? "", clerk_org_id: orgId ?? "" },
      });
    } else if (event.type === "session.created") {
      // data.user_id — the Clerk user ID who signed in
      const clerkUserId = event.data.user_id as string | undefined;
      // Look up local user record for actor_user_id and actor_email (C5: ip=NULL)
      let internalUserId: string | null = null;
      let internalEmail: string | null = null;
      if (clerkUserId) {
        const { rows: userRows } = await pool.query<{ id: string; email: string }>(
          "SELECT id, email FROM users WHERE clerk_user_id = $1 LIMIT 1",
          [clerkUserId],
        );
        internalUserId = userRows[0]?.id ?? null;
        internalEmail  = userRows[0]?.email ?? null;
      }
      recordActivity({
        eventType: ActivityEventType.USER_SIGNED_IN,
        actorType: "user",
        actorUserId: internalUserId,
        actorEmail:  internalEmail,
        ip: null,
        requestId: svixId,
        metadata: { clerk_user_id: clerkUserId ?? "" },
      });
    }
  } catch (err) {
    console.error("[webhooks] event handling error:", err);
    res.status(500).json({ error: "internal_error" });
    return;
  }

  res.json({ received: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function revokeKeysByCreator(
  clerkUserId: string,
  clerkOrgId: string,
  reason: string,
): Promise<void> {
  await pool.query(
    `UPDATE api_keys
     SET revoked_at = now(), revoked_reason = $1
     WHERE revoked_at IS NULL
       AND created_by IN (SELECT id FROM users WHERE clerk_user_id = $2)
       AND org_id     IN (SELECT id FROM orgs  WHERE clerk_org_id  = $3)`,
    [reason, clerkUserId, clerkOrgId],
  );
}

async function revokeKeysByCreatorAllOrgs(
  clerkUserId: string,
  reason: string,
): Promise<void> {
  await pool.query(
    `UPDATE api_keys
     SET revoked_at = now(), revoked_reason = $1
     WHERE revoked_at IS NULL
       AND created_by IN (SELECT id FROM users WHERE clerk_user_id = $2)`,
    [reason, clerkUserId],
  );
}
