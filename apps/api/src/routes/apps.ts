import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { pool } from "../db";
import { destroyFlyApp } from "../services/flyClient";
import { asyncHandler } from "../lib/asyncHandler";

export const appsRouter = Router();
appsRouter.use(requireAuth);

// Resolve internal org ID for both auth types
async function getOrgId(req: Request): Promise<string | null> {
  const sscAuth = req.sscAuth!;
  if (sscAuth.type === "api_key") return sscAuth.internalOrgId!;
  if (!sscAuth.clerkOrgId) return null;
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM orgs WHERE clerk_org_id = $1",
    [sscAuth.clerkOrgId],
  );
  return rows[0]?.id ?? null;
}

appsRouter.get("/", asyncHandler(async (req: Request, res: Response) => {
  const orgId = await getOrgId(req);
  if (!orgId) { res.status(400).json({ error: "no_active_org" }); return; }

  const { rows } = await pool.query(
    `SELECT id, name, slug, source_type, source_ref, fly_app_id, subdomain, created_at
     FROM apps WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [orgId],
  );
  res.json(rows);
}));

appsRouter.get("/:id", asyncHandler(async (req: Request, res: Response) => {
  const orgId = await getOrgId(req);
  if (!orgId) { res.status(400).json({ error: "no_active_org" }); return; }

  const { rows } = await pool.query(
    `SELECT id, name, slug, source_type, source_ref, fly_app_id, subdomain, created_at
     FROM apps WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
    [req.params.id, orgId],
  );
  if (!rows[0]) { res.status(404).json({ error: "app_not_found" }); return; }
  res.json(rows[0]);
}));

// DELETE /v1/apps/:id
// Destroys the Fly app, marks DB record deleted (soft-delete via deleted_at)
appsRouter.delete("/:id", asyncHandler(async (req: Request, res: Response) => {
  const orgId = await getOrgId(req);
  if (!orgId) { res.status(400).json({ error: "no_active_org" }); return; }

  const { rows } = await pool.query<{ id: string; fly_app_id: string | null }>(
    "SELECT id, fly_app_id FROM apps WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL",
    [req.params.id, orgId],
  );
  if (!rows[0]) { res.status(404).json({ error: "app_not_found" }); return; }

  const { fly_app_id } = rows[0];

  // Destroy on Fly.io (fire-and-forget if it fails)
  if (fly_app_id) {
    try {
      await destroyFlyApp(fly_app_id);
    } catch (err) {
      console.error(`[apps] failed to destroy Fly app ${fly_app_id}:`, err);
    }
  }

  await pool.query(
    "UPDATE apps SET deleted_at = now() WHERE id = $1",
    [req.params.id],
  );

  res.status(200).json({ deleted: true });
}));
