import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireScope } from "../middleware/requireScope";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";

export const deploymentsRouter = Router();
deploymentsRouter.use(requireAuth);

async function resolveCallerOrgId(req: Request): Promise<string | null> {
  const sscAuth = req.sscAuth!;
  if (sscAuth.type === "api_key") return sscAuth.internalOrgId!;
  if (!sscAuth.clerkOrgId) return null;
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM orgs WHERE clerk_org_id = $1",
    [sscAuth.clerkOrgId],
  );
  return rows[0]?.id ?? null;
}

deploymentsRouter.get("/:id", requireScope("read"), asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  const callerOrgId = await resolveCallerOrgId(req);
  if (!callerOrgId) {
    res.status(400).json({ error: "no_active_org" });
    return;
  }

  const { rows } = await pool.query(
    `SELECT
       d.id, d.app_id, d.status, d.version, d.started_at, d.finished_at,
       d.fly_machine_id, d.failure_stage, d.failure_message,
       a.name AS app_name, a.subdomain, a.fly_app_id, a.org_id
     FROM deployments d
     JOIN apps a ON a.id = d.app_id
     WHERE d.id = $1`,
    [id],
  );

  if (rows.length === 0 || rows[0].org_id !== callerOrgId) {
    res.status(404).json({ error: "deployment_not_found" });
    return;
  }

  const row = rows[0];
  res.json({
    id: row.id,
    app_id: row.app_id,
    app_name: row.app_name,
    status: row.status,
    version: row.version,
    started_at: row.started_at,
    finished_at: row.finished_at,
    fly_machine_id: row.fly_machine_id ?? null,
    failure_stage: row.failure_stage ?? null,
    failure_message: row.failure_message ?? null,
    url: row.subdomain ? `https://${row.subdomain}` : null,
    stream_url: `/v1/deployments/${id}/stream`,
  });
}));
