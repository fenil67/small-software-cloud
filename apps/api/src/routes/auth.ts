/**
 * GET /v1/auth/check
 *
 * Validates the caller's credentials and returns basic org info.
 * Used by `ssc login` to confirm a key is valid before saving it.
 *
 * Response: { org: string }
 */

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { pool } from "../db";

export const authRouter = Router();
authRouter.use(requireAuth);

authRouter.get("/check", async (req: Request, res: Response) => {
  const sscAuth = req.sscAuth!;

  let orgId: string;

  if (sscAuth.type === "api_key") {
    orgId = sscAuth.internalOrgId!;
  } else {
    // Clerk path — look up or create org record
    if (!sscAuth.clerkOrgId) {
      res.status(400).json({
        error: "no_active_org",
        message: "No active organization in session.",
      });
      return;
    }

    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM orgs WHERE clerk_org_id = $1",
      [sscAuth.clerkOrgId],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "org_not_found" });
      return;
    }
    orgId = rows[0].id;
  }

  const { rows } = await pool.query<{ name: string }>(
    "SELECT name FROM orgs WHERE id = $1",
    [orgId],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "org_not_found" });
    return;
  }

  res.json({ org: rows[0].name });
});
