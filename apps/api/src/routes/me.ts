/**
 * GET /v1/me        → { is_admin: boolean, open_alert_count: number | null }
 * GET /v1/me/shared-apps → SharedApp[]
 *
 * Auth: Clerk session only. API key → 403.
 */

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../lib/asyncHandler";
import { pool } from "../db";
import { isAdminId } from "./admin";
import { normalizeAppUrl } from "../lib/appUrl";
import { getUserOrgIds } from "../lib/clerkSync";

export const meRouter = Router();
meRouter.use(requireAuth);

// ── GET /v1/me ────────────────────────────────────────────────────────────────

meRouter.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    if (req.sscAuth?.type !== "clerk") {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const clerkUserId = req.sscAuth.clerkUserId!;
    const is_admin = isAdminId(clerkUserId);

    let open_alert_count: number | null = null;
    if (is_admin) {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM watchdog_alerts WHERE created_at > now() - INTERVAL '7 days'`,
      );
      open_alert_count = rows[0]?.n ?? 0;
    }

    res.json({ is_admin, open_alert_count });
  }),
);

// ── GET /v1/me/shared-apps ────────────────────────────────────────────────────

interface SharedAppRow {
  app_id: string;
  app_name: string;
  url: string | null;
  org_name: string;
  granted_at: Date | null;
  status: string;
}

meRouter.get(
  "/shared-apps",
  asyncHandler(async (req: Request, res: Response) => {
    if (req.sscAuth?.type !== "clerk") {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const clerkUserId = req.sscAuth.clerkUserId!;

    // Look up internal user
    const { rows: userRows } = await pool.query<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE clerk_user_id = $1 LIMIT 1",
      [clerkUserId],
    );

    if (!userRows[0]) {
      res.json([]);
      return;
    }

    const internalUserId = userRows[0].id;
    const userEmail = userRows[0].email;

    // Fetch all Clerk org memberships for this user so we can exclude apps from
    // orgs the user already belongs to (they appear in "Your apps", not "Shared with you").
    const memberClerkOrgIds = await getUserOrgIds(clerkUserId);
    if (memberClerkOrgIds === null) {
      res.status(503).json({ error: "clerk_unavailable" });
      return;
    }

    // Also fold in the active org (always a member org; Clerk stubs in tests may not list it).
    const clerkOrgId = req.sscAuth!.clerkOrgId;
    const allMemberClerkIds = clerkOrgId
      ? Array.from(new Set([...memberClerkOrgIds, clerkOrgId]))
      : memberClerkOrgIds;

    // Resolve Clerk org IDs → internal UUIDs
    let memberInternalOrgIds: string[] = [];
    if (allMemberClerkIds.length > 0) {
      const { rows: memberOrgRows } = await pool.query<{ id: string }>(
        "SELECT id FROM orgs WHERE clerk_org_id = ANY($1::text[]) AND deleted_at IS NULL",
        [allMemberClerkIds],
      );
      memberInternalOrgIds = memberOrgRows.map((r) => r.id);
    }

    // Build the exclusion clause: use array parameter when we have orgs to exclude
    const orgFilter = memberInternalOrgIds.length > 0 ? "AND a.org_id != ALL($3::uuid[])" : "";
    const queryParams: unknown[] = memberInternalOrgIds.length > 0
      ? [internalUserId, userEmail, memberInternalOrgIds]
      : [internalUserId, userEmail];

    const { rows } = await pool.query<SharedAppRow>(`
      SELECT
        a.id        AS app_id,
        a.name      AS app_name,
        a.subdomain AS url,
        o.name      AS org_name,
        aa.created_at AS granted_at,
        'active'    AS status
      FROM app_access aa
      JOIN apps a ON a.id = aa.app_id AND a.deleted_at IS NULL
      JOIN orgs o ON o.id = a.org_id AND o.deleted_at IS NULL
      WHERE aa.user_id = $1
        ${orgFilter}

      UNION ALL

      SELECT
        a.id        AS app_id,
        a.name      AS app_name,
        a.subdomain AS url,
        o.name      AS org_name,
        pa.created_at AS granted_at,
        'pending'   AS status
      FROM pending_access pa
      JOIN apps a ON a.id = pa.app_id AND a.deleted_at IS NULL
      JOIN orgs o ON o.id = a.org_id AND o.deleted_at IS NULL
      WHERE lower(pa.email) = lower($2)
        AND NOT EXISTS (
          SELECT 1 FROM app_access aa2
          WHERE aa2.app_id = pa.app_id AND aa2.user_id = $1
        )
        ${orgFilter}

      ORDER BY granted_at DESC NULLS LAST
    `, queryParams);

    const result = rows.map((r) => ({
      app_id: r.app_id,
      app_name: r.app_name,
      url: normalizeAppUrl(r.url),
      org_name: r.org_name,
      granted_at: r.granted_at ? r.granted_at.toISOString() : null,
      status: r.status as "active" | "pending",
    }));

    res.json(result);
  }),
);
