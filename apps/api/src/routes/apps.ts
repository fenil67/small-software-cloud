import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireScope } from "../middleware/requireScope";
import { pool } from "../db";
import { destroyFlyApp } from "../services/flyClient";
import { asyncHandler } from "../lib/asyncHandler";
import { safeErr } from "../lib/safeErr";

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

appsRouter.get("/", requireScope("read"), asyncHandler(async (req: Request, res: Response) => {
  const orgId = await getOrgId(req);
  if (!orgId) { res.status(400).json({ error: "no_active_org" }); return; }

  const { rows } = await pool.query(
    `SELECT
       a.id, a.name, a.slug, a.source_type, a.source_ref,
       a.fly_app_id, a.subdomain, a.created_at,
       a.suspended_at IS NOT NULL AS suspended,
       a.status,
       (SELECT d.status FROM deployments d
        WHERE d.app_id = a.id
        ORDER BY d.created_at DESC LIMIT 1) AS latest_deployment_status,
       (SELECT d.finished_at FROM deployments d
        WHERE d.app_id = a.id AND d.status IN ('success','failed','cancelled')
        ORDER BY d.created_at DESC LIMIT 1) AS last_deployed_at
     FROM apps a
     WHERE a.org_id = $1 AND a.deleted_at IS NULL
     ORDER BY a.created_at DESC`,
    [orgId],
  );
  res.json(rows);
}));

appsRouter.get("/:id", requireScope("read"), asyncHandler(async (req: Request, res: Response) => {
  const orgId = await getOrgId(req);
  if (!orgId) { res.status(400).json({ error: "no_active_org" }); return; }

  const { rows } = await pool.query(
    `SELECT
       a.id, a.name, a.slug, a.source_type, a.source_ref,
       a.fly_app_id, a.subdomain, a.created_at,
       a.suspended_at IS NOT NULL AS suspended,
       a.status,
       (SELECT d.status FROM deployments d
        WHERE d.app_id = a.id
        ORDER BY d.created_at DESC LIMIT 1) AS latest_deployment_status,
       (SELECT d.finished_at FROM deployments d
        WHERE d.app_id = a.id AND d.status IN ('success','failed','cancelled')
        ORDER BY d.created_at DESC LIMIT 1) AS last_deployed_at
     FROM apps a
     WHERE a.id = $1 AND a.org_id = $2 AND a.deleted_at IS NULL`,
    [req.params.id, orgId],
  );
  if (!rows[0]) { res.status(404).json({ error: "app_not_found" }); return; }
  res.json(rows[0]);
}));

// GET /v1/apps/:id/deployments — last 50 deployments for an app, newest first
appsRouter.get("/:id/deployments", requireScope("read"), asyncHandler(async (req: Request, res: Response) => {
  const orgId = await getOrgId(req);
  if (!orgId) { res.status(400).json({ error: "no_active_org" }); return; }

  // Verify app belongs to this org
  const appCheck = await pool.query<{ id: string }>(
    "SELECT id FROM apps WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL",
    [req.params.id, orgId],
  );
  if (!appCheck.rows[0]) { res.status(404).json({ error: "app_not_found" }); return; }

  const { rows } = await pool.query(
    `SELECT id, status, version, started_at, finished_at, failure_stage, failure_message
     FROM deployments
     WHERE app_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [req.params.id],
  );
  res.json(rows);
}));

// DELETE /v1/apps/:id
// Destroys the Fly app, marks DB record deleted (soft-delete via deleted_at)
appsRouter.delete("/:id", requireScope("manage"), asyncHandler(async (req: Request, res: Response) => {
  const sscAuth = req.sscAuth!;

  // Clerk sessions require org:admin — API keys with manage scope are allowed
  if (sscAuth.type === "clerk" && sscAuth.clerkOrgRole !== "org:admin") {
    res.status(403).json({ error: "org_admin_required" });
    return;
  }

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
      console.error(`[apps] failed to destroy Fly app ${fly_app_id}:`, safeErr(err));
    }
  }

  await pool.query(
    "UPDATE apps SET deleted_at = now() WHERE id = $1",
    [req.params.id],
  );

  res.status(200).json({ deleted: true });
}));
