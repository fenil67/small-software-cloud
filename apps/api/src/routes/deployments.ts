/**
 * Deployment status endpoint.
 *
 * GET /v1/deployments/:id   — returns current status + metadata from DB
 */

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { pool } from "../db";

export const deploymentsRouter = Router();
deploymentsRouter.use(requireAuth);

deploymentsRouter.get("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;

  const { rows } = await pool.query(
    `SELECT
       d.id,
       d.app_id,
       d.status,
       d.version,
       d.started_at,
       d.finished_at,
       d.fly_machine_id,
       d.error_message,
       a.name        AS app_name,
       a.subdomain,
       a.fly_app_id
     FROM deployments d
     JOIN apps a ON a.id = d.app_id
     WHERE d.id = $1`,
    [id]
  );

  if (rows.length === 0) {
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
    error_message: row.error_message ?? null,
    url: row.subdomain ? `https://${row.subdomain}` : null,
    stream_url: `/v1/deployments/${id}/stream`,
  });
});
