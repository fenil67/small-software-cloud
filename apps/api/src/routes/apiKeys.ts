import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { pool } from "../db";
import { generateApiKey } from "../lib/apiKeys";
import { ensureUser, ensureOrg } from "../lib/clerkSync";

export const apiKeysRouter = Router();
apiKeysRouter.use(requireAuth);

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

apiKeysRouter.post("/", requireClerkOrgAdmin, async (req: Request, res: Response) => {
  const sscAuth = req.sscAuth!;
  const { name } = req.body as { name?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: "validation_error", message: "Field 'name' is required." });
    return;
  }

  const userId = await ensureUser(sscAuth.clerkUserId!);
  const orgId = await ensureOrg(sscAuth.clerkOrgId!);
  const { fullKey, keyPrefix, keyHash } = generateApiKey();

  const { rows } = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO api_keys (org_id, created_by, name, key_prefix, key_hash)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
    [orgId, userId, name.trim(), keyPrefix, keyHash],
  );

  res.status(201).json({
    id: rows[0].id,
    name: name.trim(),
    key: fullKey,
    key_prefix: keyPrefix,
    created_at: rows[0].created_at,
  });
});

apiKeysRouter.get("/", requireClerkOrgAdmin, async (req: Request, res: Response) => {
  const sscAuth = req.sscAuth!;
  const orgId = await ensureOrg(sscAuth.clerkOrgId!);

  const { rows } = await pool.query(
    `SELECT id, name, key_prefix, created_at, last_used_at, revoked_at
     FROM api_keys WHERE org_id = $1 ORDER BY created_at DESC`,
    [orgId],
  );
  res.json(rows);
});

apiKeysRouter.delete("/:id", requireClerkOrgAdmin, async (req: Request, res: Response) => {
  const sscAuth = req.sscAuth!;
  const orgId = await ensureOrg(sscAuth.clerkOrgId!);

  const { rowCount } = await pool.query(
    `UPDATE api_keys SET revoked_at = now()
     WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL`,
    [req.params.id, orgId],
  );
  if (!rowCount) { res.status(404).json({ error: "key_not_found" }); return; }
  res.json({ revoked: true });
});
