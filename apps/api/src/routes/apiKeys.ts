import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { pool } from "../db";
import { generateApiKey } from "../lib/apiKeys";
import { ensureUser, ensureOrg } from "../lib/clerkSync";
import { asyncHandler } from "../lib/asyncHandler";
import { ActivityEventType, recordActivity, recordActivityInTx } from "../lib/activityLog";

export const apiKeysRouter = Router();
apiKeysRouter.use(requireAuth);

const VALID_SCOPES = new Set(["read", "deploy", "manage"]);
const DEFAULT_SCOPES: string[] = ["read", "deploy"];

// Only Clerk org admins can manage API keys (API key auth can't create more keys)
function requireClerkOrgAdmin(req: Request, res: Response, next: NextFunction): void {
  const sscAuth = req.sscAuth!;
  if (sscAuth.type !== "clerk") {
    res.status(403).json({ error: "clerk_session_required", message: "API key management requires a Clerk session, not an API key." });
    return;
  }
  if (!sscAuth.clerkOrgId) {
    res.status(403).json({ error: "no_active_org", message: "No active organization in session. Switch to an org in your Clerk session." });
    return;
  }
  // org_role from Clerk JWT: "org:admin", "org:member", etc.
  const role = sscAuth.clerkOrgRole ?? "";
  if (role !== "org:admin") {
    res.status(403).json({ error: "org_admin_required", message: "Organization admin role required to manage API keys." });
    return;
  }
  next();
}

apiKeysRouter.post("/", requireClerkOrgAdmin, asyncHandler(async (req: Request, res: Response) => {
  const sscAuth = req.sscAuth!;
  const { name, scopes: rawScopes } = req.body as { name?: string; scopes?: unknown };
  if (!name?.trim()) {
    res.status(400).json({ error: "validation_error", message: "Field 'name' is required." });
    return;
  }

  let scopes: string[];
  if (rawScopes !== undefined) {
    if (!Array.isArray(rawScopes) || rawScopes.length === 0) {
      res.status(400).json({ error: "validation_error", message: "scopes must be a non-empty array." });
      return;
    }
    for (const s of rawScopes) {
      if (typeof s !== "string" || !VALID_SCOPES.has(s)) {
        res.status(400).json({ error: "validation_error", message: `Invalid scope: "${String(s)}". Must be one of: read, deploy, manage.` });
        return;
      }
    }
    scopes = [...new Set(rawScopes as string[])]; // deduplicate
  } else {
    scopes = DEFAULT_SCOPES;
  }

  const userId = await ensureUser(sscAuth.clerkUserId!);
  const orgId = await ensureOrg(sscAuth.clerkOrgId!);
  const { fullKey, keyPrefix, keyHash } = generateApiKey();

  const { rows } = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO api_keys (org_id, created_by, name, key_prefix, key_hash, scopes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
    [orgId, userId, name.trim(), keyPrefix, keyHash, scopes],
  );

  const { rows: ke } = await pool.query<{ email: string }>(
    "SELECT email FROM users WHERE id = $1", [userId]);
  const actorEmail = ke[0]?.email ?? null;

  // Best-effort activity log for key creation
  recordActivity({
    eventType: ActivityEventType.KEY_CREATED,
    actorType: sscAuth.type === "clerk" ? "user" : "api_key",
    actorUserId: userId,
    actorKeyId: sscAuth.type === "api_key" ? (sscAuth.apiKeyId ?? null) : null,
    actorEmail,
    orgId,
    targetId: keyPrefix,
    metadata: {
      name: name.trim().slice(0, 100),
      scopes: scopes.join(","),
    },
  });

  res.status(201).json({
    id: rows[0].id,
    name: name.trim(),
    key: fullKey,
    key_prefix: keyPrefix,
    scopes,
    created_at: rows[0].created_at,
  });
}));

apiKeysRouter.get("/", asyncHandler(async (req: Request, res: Response) => {
  const sscAuth = req.sscAuth!;
  if (sscAuth.type !== "clerk") {
    res.status(403).json({ error: "clerk_session_required", message: "API key management requires a Clerk session." });
    return;
  }
  if (!sscAuth.clerkOrgId) {
    res.status(403).json({ error: "no_active_org", message: "No active organization in session." });
    return;
  }

  const orgId = await ensureOrg(sscAuth.clerkOrgId);
  const isAdmin = sscAuth.clerkOrgRole === "org:admin";

  if (isAdmin) {
    // Admins see all keys in the org with the creator's email
    const { rows } = await pool.query(
      `SELECT k.id, k.name, k.key_prefix, k.scopes, k.created_at, k.last_used_at, k.revoked_at,
              u.email AS created_by_email
       FROM api_keys k
       LEFT JOIN users u ON u.id = k.created_by
       WHERE k.org_id = $1
       ORDER BY k.created_at DESC`,
      [orgId],
    );
    res.json(rows);
  } else {
    // Members see only their own keys
    const userId = await ensureUser(sscAuth.clerkUserId!);
    const { rows } = await pool.query(
      `SELECT id, name, key_prefix, scopes, created_at, last_used_at, revoked_at
       FROM api_keys WHERE org_id = $1 AND created_by = $2 ORDER BY created_at DESC`,
      [orgId, userId],
    );
    res.json(rows);
  }
}));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

apiKeysRouter.delete("/:id", asyncHandler(async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const sscAuth = req.sscAuth!;
  if (sscAuth.type !== "clerk") {
    res.status(403).json({ error: "clerk_session_required", message: "API key management requires a Clerk session." });
    return;
  }
  if (!sscAuth.clerkOrgId) {
    res.status(403).json({ error: "no_active_org", message: "No active organization in session." });
    return;
  }

  const orgId = await ensureOrg(sscAuth.clerkOrgId);
  const isAdmin = sscAuth.clerkOrgRole === "org:admin";
  // For members, resolve userId before the query (needed for the created_by filter).
  // For admins, defer ensureUser until after the rowCount check so a UUID-not-in-DB
  // request returns 404 without calling the Clerk API unnecessarily.
  const memberUserId = isAdmin ? null : await ensureUser(sscAuth.clerkUserId!);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Admins can revoke any key in the org; members can only revoke their own
    const { rowCount } = isAdmin
      ? await client.query(
          `UPDATE api_keys SET revoked_at = now()
           WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL`,
          [req.params.id, orgId],
        )
      : await client.query(
          `UPDATE api_keys SET revoked_at = now()
           WHERE id = $1 AND org_id = $2 AND created_by = $3 AND revoked_at IS NULL`,
          [req.params.id, orgId, memberUserId],
        );
    if (!rowCount) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "key_not_found" });
      return;
    }
    // Resolve actor for activity log (admin path: now safe to call after key exists)
    const userId = memberUserId ?? (await ensureUser(sscAuth.clerkUserId!));
    const { rows: ke2 } = await client.query<{ email: string }>(
      "SELECT email FROM users WHERE id = $1", [userId]);
    const revokeActorEmail = ke2[0]?.email ?? null;
    await recordActivityInTx(client, {
      eventType: ActivityEventType.KEY_REVOKED,
      actorType: "user",
      actorUserId: userId,
      actorEmail: revokeActorEmail,
      orgId,
      targetId: req.params.id,
      metadata: {},
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  res.json({ revoked: true });
}));
