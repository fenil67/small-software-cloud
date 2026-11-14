import { Router, Request, Response } from "express";
import { pool } from "../db";
import { eventBus } from "../lib/eventBus";
import { requireAuth } from "../middleware/requireAuth";
import { requireScope } from "../middleware/requireScope";
import { asyncHandler } from "../lib/asyncHandler";

export const deployStreamRouter = Router();
deployStreamRouter.use(requireAuth);

const PING_INTERVAL_MS = 15_000;

async function getOrgIdForDeployment(deploymentId: string): Promise<string | null> {
  const { rows } = await pool.query<{ org_id: string }>(
    `SELECT a.org_id FROM deployments d JOIN apps a ON a.id = d.app_id WHERE d.id = $1`,
    [deploymentId],
  );
  return rows[0]?.org_id ?? null;
}

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

deployStreamRouter.get("/:id/stream", requireScope("read"), asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  // Auth: verify caller owns this deployment's org
  const callerOrgId = await resolveCallerOrgId(req);
  const deploymentOrgId = await getOrgIdForDeployment(id);

  if (!deploymentOrgId) {
    res.status(404).json({ error: "deployment_not_found" });
    return;
  }
  if (!callerOrgId || callerOrgId !== deploymentOrgId) {
    res.status(404).json({ error: "deployment_not_found" });
    return;
  }

  const { rows } = await pool.query<{
    status: string;
    failure_stage: string | null;
    failure_message: string | null;
  }>(
    "SELECT status, failure_stage, failure_message FROM deployments WHERE id = $1",
    [id],
  );

  if (rows.length === 0) {
    res.status(404).json({ error: "deployment_not_found" });
    return;
  }

  const row = rows[0];
  const terminalStatuses = new Set(["success", "failed"]);

  if (terminalStatuses.has(row.status)) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    if (row.status === "failed" && row.failure_stage && row.failure_message) {
      res.write(`data: ${JSON.stringify({ type: "error", stage: row.failure_stage, message: row.failure_message })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ type: "status", status: row.status })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const emitter = eventBus.getOrCreate(id);
  const ping = setInterval(() => { res.write(": ping\n\n"); }, PING_INTERVAL_MS);

  function onEvent(event: unknown) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event !== null && typeof event === "object" && "type" in event && (event as { type: string }).type === "done") {
      cleanup();
      res.end();
    }
  }

  function cleanup() {
    clearInterval(ping);
    emitter.off("event", onEvent);
  }

  emitter.on("event", onEvent);
  req.on("close", cleanup);
}));
