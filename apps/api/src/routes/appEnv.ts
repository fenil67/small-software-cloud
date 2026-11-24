/**
 * GET    /v1/apps/:id/env              → list env var names with metadata (never values)
 * PUT    /v1/apps/:id/env              → set or replace a variable
 * DELETE /v1/apps/:id/env/:name        → remove a variable
 * POST   /v1/apps/:id/env/apply        → restart machines so staged secrets take effect
 *
 * Authorization:
 *   GET  — workspace member or read-scope key (org check; shared viewers 404)
 *   PUT/DELETE/apply — org:admin (Clerk) or manage-scope key; members 403
 *
 * Values are NEVER stored in the database, NEVER returned by any endpoint,
 * and NEVER logged. Only names are persisted in app_env_vars.
 */

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireScope } from "../middleware/requireScope";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { ActivityEventType, recordActivity } from "../lib/activityLog";
import {
  setFlySecret,
  unsetFlySecret,
  updateFlyMachines,
} from "../services/flyClient";

export const appEnvRouter = Router({ mergeParams: true });
appEnvRouter.use(requireAuth);

// ── Validation ────────────────────────────────────────────────────────────────

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

const NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const RESERVED_RE = /^(PORT|SSC_|FLY_)/;
const MAX_VARS = 50;
const MAX_VALUE_BYTES = 32768;

function validateName(name: string): string | null {
  if (!NAME_RE.test(name)) return "invalid_name";
  if (RESERVED_RE.test(name)) return "reserved_name";
  return null;
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

interface OrgCtx {
  orgId: string;
  userId: string | null; // internal users.id
  isAdmin: boolean;      // org:admin (Clerk) or any manage-scope key holder
}

/** Resolve org and caller from auth context. Returns null and sends 400/404 on failure. */
async function resolveOrg(req: Request, res: Response): Promise<OrgCtx | null> {
  const sscAuth = req.sscAuth!;

  if (sscAuth.type === "api_key") {
    return {
      orgId: sscAuth.internalOrgId!,
      userId: sscAuth.apiKeyCreatedBy ?? null,
      isAdmin: (sscAuth.apiKeyScopes ?? []).includes("manage"),
    };
  }

  if (!sscAuth.clerkOrgId) {
    res.status(400).json({ error: "no_active_org" });
    return null;
  }

  const { rows: orgRows } = await pool.query<{ id: string }>(
    "SELECT id FROM orgs WHERE clerk_org_id = $1",
    [sscAuth.clerkOrgId],
  );
  if (!orgRows[0]) {
    res.status(404).json({ error: "app_not_found" });
    return null;
  }

  let userId: string | null = null;
  if (sscAuth.clerkUserId) {
    const { rows: uRows } = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE clerk_user_id = $1",
      [sscAuth.clerkUserId],
    );
    userId = uRows[0]?.id ?? null;
  }

  return {
    orgId: orgRows[0].id,
    userId,
    isAdmin: sscAuth.clerkOrgRole === "org:admin",
  };
}

interface AppCtx extends OrgCtx {
  appId: string;
  flyAppId: string | null;
  suspended: boolean;
}

/** Resolve org + verify app ownership. Returns null on 404. */
async function resolveApp(req: Request, res: Response): Promise<AppCtx | null> {
  if (!isUuid(req.params.id)) {
    res.status(404).json({ error: "app_not_found" });
    return null;
  }

  const orgCtx = await resolveOrg(req, res);
  if (!orgCtx) return null;

  const { rows } = await pool.query<{ id: string; fly_app_id: string | null; suspended: boolean }>(
    `SELECT id, fly_app_id, suspended_at IS NOT NULL AS suspended
     FROM apps WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
    [req.params.id, orgCtx.orgId],
  );
  if (!rows[0]) {
    res.status(404).json({ error: "app_not_found" });
    return null;
  }

  return {
    ...orgCtx,
    appId: rows[0].id,
    flyAppId: rows[0].fly_app_id,
    suspended: rows[0].suspended,
  };
}

// ── GET / — list names (never values) ─────────────────────────────────────────

appEnvRouter.get(
  "/",
  requireScope("read"),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await resolveApp(req, res);
    if (!ctx) return;

    const { rows } = await pool.query<{
      name: string;
      updated_at: string;
      updated_by_email: string | null;
    }>(
      `SELECT e.name, e.updated_at,
              u.email AS updated_by_email
       FROM app_env_vars e
       LEFT JOIN users u ON u.id = e.updated_by
       WHERE e.app_id = $1
       ORDER BY e.name`,
      [ctx.appId],
    );

    res.json(rows);
  }),
);

// ── PUT / — set or replace a variable ─────────────────────────────────────────

appEnvRouter.put(
  "/",
  requireScope("manage"),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await resolveApp(req, res);
    if (!ctx) return;

    // Clerk callers must be org:admin
    if (req.sscAuth!.type === "clerk" && !ctx.isAdmin) {
      res.status(403).json({ error: "org_admin_required" });
      return;
    }

    if (ctx.suspended) {
      res.status(423).json({ error: "app_suspended" });
      return;
    }

    const { name, value } = req.body as { name?: unknown; value?: unknown };

    if (typeof name !== "string" || typeof value !== "string") {
      res.status(400).json({ error: "name and value are required" });
      return;
    }

    const nameErr = validateName(name);
    if (nameErr) {
      res.status(400).json({ error: nameErr });
      return;
    }

    if (value.length === 0) {
      res.status(400).json({ error: "empty_value" });
      return;
    }
    if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
      res.status(400).json({ error: "value_too_large" });
      return;
    }

    // Enforce per-app limit (only for new vars)
    const { rows: countRows } = await pool.query<{ cnt: string }>(
      "SELECT COUNT(*) AS cnt FROM app_env_vars WHERE app_id = $1 AND name != $2",
      [ctx.appId, name],
    );
    if (parseInt(countRows[0].cnt, 10) >= MAX_VARS) {
      res.status(400).json({ error: "too_many_vars" });
      return;
    }

    // Push to Fly first (fail-fast: if Fly rejects it, we don't store the name)
    if (ctx.flyAppId) {
      await setFlySecret(ctx.flyAppId, name, value);
    }

    // Store the name (upsert)
    await pool.query(
      `INSERT INTO app_env_vars (app_id, name, updated_at, updated_by)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (app_id, name) DO UPDATE
         SET updated_at = now(), updated_by = $3`,
      [ctx.appId, name, ctx.userId],
    );

    recordActivity({
      eventType: ActivityEventType.ENV_SET,
      actorType: req.sscAuth!.type === "api_key" ? "api_key" : "user",
      actorUserId: ctx.userId,
      actorKeyId: req.sscAuth!.type === "api_key" ? req.sscAuth!.apiKeyId : null,
      orgId: ctx.orgId,
      appId: ctx.appId,
      metadata: { name },
    });

    res.status(200).json({ ok: true });
  }),
);

// ── DELETE /:name — remove a variable ────────────────────────────────────────

appEnvRouter.delete(
  "/:name",
  requireScope("manage"),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await resolveApp(req, res);
    if (!ctx) return;

    if (req.sscAuth!.type === "clerk" && !ctx.isAdmin) {
      res.status(403).json({ error: "org_admin_required" });
      return;
    }

    if (ctx.suspended) {
      res.status(423).json({ error: "app_suspended" });
      return;
    }

    const { name } = req.params;
    const nameErr = validateName(name);
    if (nameErr) {
      res.status(400).json({ error: nameErr });
      return;
    }

    // Verify it exists in DB first
    const { rows } = await pool.query(
      "SELECT 1 FROM app_env_vars WHERE app_id = $1 AND name = $2",
      [ctx.appId, name],
    );
    if (!rows[0]) {
      res.status(404).json({ error: "env_var_not_found" });
      return;
    }

    // Remove from Fly (404 is tolerated — secret may never have been pushed)
    if (ctx.flyAppId) {
      await unsetFlySecret(ctx.flyAppId, name);
    }

    await pool.query(
      "DELETE FROM app_env_vars WHERE app_id = $1 AND name = $2",
      [ctx.appId, name],
    );

    recordActivity({
      eventType: ActivityEventType.ENV_UNSET,
      actorType: req.sscAuth!.type === "api_key" ? "api_key" : "user",
      actorUserId: ctx.userId,
      actorKeyId: req.sscAuth!.type === "api_key" ? req.sscAuth!.apiKeyId : null,
      orgId: ctx.orgId,
      appId: ctx.appId,
      metadata: { name },
    });

    res.status(200).json({ ok: true });
  }),
);

// ── POST /apply — restart machines ────────────────────────────────────────────

appEnvRouter.post(
  "/apply",
  requireScope("manage"),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await resolveApp(req, res);
    if (!ctx) return;

    if (req.sscAuth!.type === "clerk" && !ctx.isAdmin) {
      res.status(403).json({ error: "org_admin_required" });
      return;
    }

    if (ctx.suspended) {
      res.status(423).json({ error: "app_suspended" });
      return;
    }

    if (!ctx.flyAppId) {
      res.status(409).json({ error: "app_not_deployed" });
      return;
    }

    const result = await updateFlyMachines(ctx.flyAppId);
    res.json({ updated: result.updated });
  }),
);
