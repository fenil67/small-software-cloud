import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { pool } from "../db";

export const orgsRouter = Router();
orgsRouter.use(requireAuth);

orgsRouter.get("/current", async (req: Request, res: Response) => {
  const sscAuth = req.sscAuth!;
  let orgId: string;

  if (sscAuth.type === "api_key") {
    orgId = sscAuth.internalOrgId!;
  } else {
    if (!sscAuth.clerkOrgId) {
      res.status(400).json({ error: "no_active_org" });
      return;
    }
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM orgs WHERE clerk_org_id = $1",
      [sscAuth.clerkOrgId],
    );
    if (!rows[0]) { res.status(404).json({ error: "org_not_found" }); return; }
    orgId = rows[0].id;
  }

  const { rows } = await pool.query("SELECT id, name FROM orgs WHERE id = $1", [orgId]);
  res.json(rows[0] ?? {});
});
