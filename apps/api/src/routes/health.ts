import { Router } from "express";
import { pool } from "../db";
import { isShuttingDown } from "../lib/shutdown";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  // During shutdown Railway must route all new traffic to the new container.
  // 503 tells Railway's load-balancer that this instance is no longer healthy.
  if (isShuttingDown()) {
    res.status(503).json({ status: "shutting_down" });
    return;
  }
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "ok" });
  } catch {
    res.status(503).json({ status: "error", db: "unreachable" });
  }
});
