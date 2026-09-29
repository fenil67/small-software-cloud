import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { pool } from "../db";
import { getAuth } from "@clerk/express";

export const appsRouter = Router();

appsRouter.use(requireAuth);

// GET /v1/apps — list apps for the caller's org
appsRouter.get("/", async (req, res) => {
  const { orgId } = getAuth(req);
  if (!orgId) {
    res.status(400).json({ error: "no_active_org" });
    return;
  }
  const { rows } = await pool.query(
    "SELECT * FROM apps WHERE org_id = $1 ORDER BY created_at DESC",
    [orgId]
  );
  res.json(rows);
});
