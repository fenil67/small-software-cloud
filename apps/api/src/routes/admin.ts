/**
 * /v1/admin — Platform admin kill switch.
 *
 * GET  /apps              — list all non-deleted apps across all orgs
 * POST /apps/:id/suspend  — suspend an app (force-destroy its machines)
 * POST /apps/:id/unsuspend — unsuspend an app
 * GET  /audit             — latest 200 audit rows
 *
 * Auth: Clerk session whose clerkUserId is in PLATFORM_ADMIN_CLERK_IDS.
 * API keys and non-admin Clerk sessions → 403 { error: "admin_required" }.
 */

import { Router, Request, Response, NextFunction } from "express";
import { pool } from "../db";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../lib/asyncHandler";
import { listMachines, destroyMachine } from "../services/flyClient";
import { ActivityEventType, recordActivityInTx } from "../lib/activityLog";
import { queryCpuMetrics, queryEgressBytes24h } from "../lib/flyMetrics";

// ── Admin ID registry ─────────────────────────────────────────────────────────

/** Each entry must match this pattern after trimming. */
const ADMIN_ID_RE = /^user_[A-Za-z0-9]+$/;

/**
 * Live set populated by validateAdminConfig().
 * Empty until validateAdminConfig() is called at startup.
 */
const _adminIds = new Set<string>();

/**
 * Called at startup (from startupChecks in src/index.ts, and from the test
 * server after it sets PLATFORM_ADMIN_CLERK_IDS).
 *
 * Parses PLATFORM_ADMIN_CLERK_IDS, fills _adminIds, and exits 1 if any entry
 * is invalid.  Never prints the invalid values themselves.
 * No parsing happens at import time.
 */
/**
 * Returns true if clerkUserId is in the admin set.
 * Used by activityAdmin.ts to avoid importing the private _adminIds set.
 */
export function isAdminId(clerkUserId: string): boolean {
  return _adminIds.has(clerkUserId);
}

export function validateAdminConfig(): void {
  _adminIds.clear();
  const invalid: string[] = [];

  const raw = (process.env.PLATFORM_ADMIN_CLERK_IDS ?? "").trim();
  if (raw) {
    for (const entry of raw.split(",")) {
      const id = entry.trim();
      if (!id) continue;
      if (ADMIN_ID_RE.test(id)) {
        _adminIds.add(id);
      } else {
        invalid.push(id);
      }
    }
  }

  if (invalid.length > 0) {
    const n = invalid.length;
    console.error(
      `[startup] FATAL: PLATFORM_ADMIN_CLERK_IDS contains ${n} invalid ` +
      `entr${n === 1 ? "y" : "ies"}. ` +
      `Each entry must match ^user_[A-Za-z0-9]+$ after trimming.`,
    );
    process.exit(1);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/** Middleware: requires a Clerk session whose user ID is in _adminIds. */
function requireAdminCheck(req: Request, res: Response, next: NextFunction): void {
  const auth = req.sscAuth;
  if (
    auth?.type !== "clerk" ||
    !auth.clerkUserId ||
    !_adminIds.has(auth.clerkUserId)
  ) {
    res.status(403).json({ error: "admin_required" });
    return;
  }
  next();
}

// ── Router ────────────────────────────────────────────────────────────────────

export const adminRouter = Router();
// requireAuth sets req.sscAuth (Clerk or API key); requireAdminCheck then
// verifies it is a Clerk admin session.
adminRouter.use(requireAuth);
adminRouter.use(requireAdminCheck);

// ── GET /v1/admin/apps ────────────────────────────────────────────────────────

adminRouter.get(
  "/apps",
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await pool.query<{
      id: string;
      name: string;
      org_id: string;
      fly_app_id: string | null;
      suspended: boolean;
      suspended_at: Date | null;
      suspend_reason: string | null;
      owner_email: string | null;
      org_name: string | null;
      last_visit_at: Date | null;
      latest_deployment_status: string | null;
    }>(`
      SELECT
        a.id,
        a.name,
        a.org_id,
        a.fly_app_id,
        a.suspended_at IS NOT NULL AS suspended,
        a.suspended_at,
        a.suspend_reason,
        u.email  AS owner_email,
        o.name   AS org_name,
        (
          SELECT occurred_at FROM activity_events
          WHERE app_id = a.id AND event_type = 'app.visit'
          ORDER BY occurred_at DESC LIMIT 1
        ) AS last_visit_at,
        (
          SELECT d.status FROM deployments d
          WHERE d.app_id = a.id
          ORDER BY d.created_at DESC LIMIT 1
        ) AS latest_deployment_status
      FROM apps a
      LEFT JOIN users u ON u.id = a.owner_id
      LEFT JOIN orgs  o ON o.id = a.org_id
      WHERE a.deleted_at IS NULL
      ORDER BY a.created_at DESC
    `);

    const [cpuSamples, egressSamples] = await Promise.all([
      queryCpuMetrics(),
      queryEgressBytes24h(),
    ]);
    const cpuByApp = new Map(cpuSamples.map((s) => [s.flyAppId, s.value]));
    const egressByApp = new Map(egressSamples.map((s) => [s.flyAppId, s.value]));

    const result = rows.map((r) => ({
      ...r,
      cpu_pct:
        r.fly_app_id && cpuByApp.has(r.fly_app_id)
          ? parseFloat((cpuByApp.get(r.fly_app_id)! * 100).toFixed(1))
          : null,
      traffic_bytes_24h:
        r.fly_app_id && egressByApp.has(r.fly_app_id)
          ? Math.round(egressByApp.get(r.fly_app_id)!)
          : null,
    }));
    res.json(result);
  }),
);

// ── POST /v1/admin/apps/:id/suspend ──────────────────────────────────────────

adminRouter.post(
  "/apps/:id/suspend",
  asyncHandler(async (req: Request, res: Response) => {
    const appId = req.params.id;

    if (!isUuid(appId)) {
      res.status(404).json({ error: "app_not_found" });
      return;
    }

    const { reason } = req.body as { reason?: string };
    const trimmedReason = (reason ?? "").trim();
    if (trimmedReason.length === 0 || trimmedReason.length > 500) {
      res.status(400).json({
        error: "validation_error",
        message: "reason is required and must be 1–500 characters",
      });
      return;
    }

    const { rows: appRows } = await pool.query<{
      id: string;
      fly_app_id: string | null;
      suspended_at: Date | null;
    }>(
      "SELECT id, fly_app_id, suspended_at FROM apps WHERE id = $1 AND deleted_at IS NULL",
      [appId],
    );
    if (!appRows[0]) {
      res.status(404).json({ error: "app_not_found" });
      return;
    }

    const app = appRows[0];
    const clerkUserId = req.sscAuth!.clerkUserId!;

    // Idempotent: already suspended → 200 without a second audit row
    if (app.suspended_at !== null) {
      res.status(200).json({ suspended: true, machines_destroyed: 0, destroy_error: false });
      return;
    }

    // Resolve internal user id for the admin actor
    const { rows: userRows } = await pool.query<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE clerk_user_id = $1",
      [clerkUserId],
    );
    const actorUserId: string | null = userRows[0]?.id ?? null;

    // Transaction: set suspension fields + insert audit row atomically
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE apps
         SET suspended_at = now(), suspended_by = $1, suspend_reason = $2
         WHERE id = $3`,
        [actorUserId, trimmedReason, appId],
      );
      await client.query(
        `INSERT INTO admin_audit
           (action, app_id, actor_user_id, actor_clerk_user_id, reason)
         VALUES ('suspend', $1, $2, $3, $4)`,
        [appId, actorUserId, clerkUserId, trimmedReason],
      );
      await recordActivityInTx(client, {
        orgId: null,
        appId,
        eventType: ActivityEventType.APP_SUSPENDED,
        actorType: "user",
        actorUserId,
        actorEmail: userRows[0]?.email ?? null,
        metadata: { reason: trimmedReason.slice(0, 100) },
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // Force-destroy every Fly machine. A single machine failure does NOT roll
    // back the suspension — the app is suspended regardless.
    let machinesDestroyed = 0;
    let destroyError = false;

    if (app.fly_app_id) {
      try {
        const machines = await listMachines(app.fly_app_id);
        await Promise.all(
          machines.map(async (m) => {
            try {
              await destroyMachine(app.fly_app_id!, m.id);
              machinesDestroyed++;
            } catch {
              destroyError = true;
            }
          }),
        );
      } catch {
        destroyError = true;
      }
    }

    res.status(200).json({ suspended: true, machines_destroyed: machinesDestroyed, destroy_error: destroyError });
  }),
);

// ── POST /v1/admin/apps/:id/unsuspend ─────────────────────────────────────────

adminRouter.post(
  "/apps/:id/unsuspend",
  asyncHandler(async (req: Request, res: Response) => {
    const appId = req.params.id;

    if (!isUuid(appId)) {
      res.status(404).json({ error: "app_not_found" });
      return;
    }

    const { rows: appRows } = await pool.query<{
      id: string;
      suspended_at: Date | null;
    }>(
      "SELECT id, suspended_at FROM apps WHERE id = $1 AND deleted_at IS NULL",
      [appId],
    );
    if (!appRows[0]) {
      res.status(404).json({ error: "app_not_found" });
      return;
    }

    // Idempotent: already unsuspended → 200 without an audit row
    if (appRows[0].suspended_at === null) {
      res.status(200).json({ suspended: false, note: "Redeploy the app to bring it back online." });
      return;
    }

    const clerkUserId = req.sscAuth!.clerkUserId!;
    const { rows: userRows } = await pool.query<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE clerk_user_id = $1",
      [clerkUserId],
    );
    const actorUserId: string | null = userRows[0]?.id ?? null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE apps
         SET suspended_at = NULL, suspended_by = NULL, suspend_reason = NULL
         WHERE id = $1`,
        [appId],
      );
      await client.query(
        `INSERT INTO admin_audit
           (action, app_id, actor_user_id, actor_clerk_user_id, reason)
         VALUES ('unsuspend', $1, $2, $3, NULL)`,
        [appId, actorUserId, clerkUserId],
      );
      await recordActivityInTx(client, {
        orgId: null,
        appId,
        eventType: ActivityEventType.APP_UNSUSPENDED,
        actorType: "user",
        actorUserId,
        actorEmail: userRows[0]?.email ?? null,
        metadata: {},
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    res.status(200).json({ suspended: false, note: "Redeploy the app to bring it back online." });
  }),
);

// ── GET /v1/admin/audit ───────────────────────────────────────────────────────

adminRouter.get(
  "/audit",
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await pool.query(`
      SELECT id, action, app_id, actor_user_id, actor_clerk_user_id, reason, created_at
      FROM admin_audit
      ORDER BY created_at DESC
      LIMIT 200
    `);
    res.json(rows);
  }),
);

// ── GET /v1/admin/alerts ──────────────────────────────────────────────────────

adminRouter.get(
  "/alerts",
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await pool.query(`
      SELECT id, app_id, kind, detail, created_at, delivered
      FROM watchdog_alerts
      ORDER BY created_at DESC
      LIMIT 200
    `);
    res.json(rows);
  }),
);
