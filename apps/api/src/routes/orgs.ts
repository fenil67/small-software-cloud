import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { pool } from "../db";
import { getAuth } from "@clerk/express";

export const orgsRouter = Router();

orgsRouter.use(requireAuth);

// GET /v1/orgs/me — fetch the caller's current org record
orgsRouter.get("/me", async (req, res) => {
  const { orgId } = getAuth(req);
  if (!orgId) {
    res.status(400).json({ error: "no_active_org" });
    return;
  }
  const { rows } = await pool.query("SELECT * FROM orgs WHERE clerk_org_id = $1", [orgId]);
  res.json(rows[0] ?? null);
});
