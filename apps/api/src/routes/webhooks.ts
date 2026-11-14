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
 *   user.deleted                   → revoke all active keys whose created_by was deleted
 */

import { Router, Request, Response } from "express";
import express from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { pool } from "../db";

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
    } else if (event.type === "user.deleted") {
      // data.id — the deleted user's Clerk ID
      const userId = event.data.id as string | undefined;
      if (userId) {
        await revokeKeysByCreatorAllOrgs(userId, "creator_deleted");
      }
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
