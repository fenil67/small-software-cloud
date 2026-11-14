/**
 * /v1/proxy — API side of the auth-proxy contract.
 *
 * POST  /codes    — Clerk session; issues a short-lived one-time code.
 * POST  /exchange — Proxy-token auth; redeems a code for user identity.
 * GET   /access   — Proxy-token auth; checks whether a user may access an app.
 */

import { Router, Request, Response } from "express";
import crypto from "crypto";
import { pool } from "../db";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../lib/asyncHandler";
import { resolveProxyToken } from "../lib/proxyCredentials";
import { ensureUser } from "../lib/clerkSync";

export const proxyRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/** base64url chars only, length 16–64. */
function isValidState(s: string): boolean {
  return /^[A-Za-z0-9_-]{16,64}$/.test(s);
}

/**
 * Same return-path validation as the proxy package:
 * exactly one leading "/", no backslashes, no control chars, max 2 048 chars.
 * Falls back to "/" for anything invalid.
 */
function safeReturnPath(raw: string | null | undefined): string {
  if (!raw || raw.length > 2048) return "/";
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return "/"; }
  if (!decoded.startsWith("/")) return "/";
  if (decoded.startsWith("//") || decoded.startsWith("/\\")) return "/";
  if (decoded.includes("\\")) return "/";
  for (let i = 0; i < decoded.length; i++) {
    if (decoded.charCodeAt(i) < 32) return "/";
  }
  return raw; // return original URL-encoded form for use in Location/query params
}

/** Extract proxy-token app_id from Authorization header, or return null. */
async function resolveProxyAuth(req: Request): Promise<string | null> {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return null;
  const token = h.slice("Bearer ".length).trim();
  return resolveProxyToken(token);
}

// ── POST /codes ───────────────────────────────────────────────────────────────

proxyRouter.post(
  "/codes",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    // Must be a Clerk session — API keys are not accepted here
    if (req.sscAuth?.type !== "clerk") {
      res.status(403).json({ error: "clerk_session_required" });
      return;
    }

    const body = req.body as { app_id?: string; state?: string; return?: string };

    // Validate app_id
    if (!body.app_id || !isUuid(body.app_id)) {
      res.status(400).json({ error: "validation_error", message: "app_id must be a UUID" });
      return;
    }

    // Validate state
    if (!body.state || !isValidState(body.state)) {
      res
        .status(400)
        .json({ error: "validation_error", message: "state must be base64url, 16 to 64 chars" });
      return;
    }

    // Fetch the app (must exist and not be deleted)
    const { rows: appRows } = await pool.query<{
      id: string;
      subdomain: string | null;
      suspended_at: Date | null;
    }>(
      "SELECT id, subdomain, suspended_at FROM apps WHERE id = $1 AND deleted_at IS NULL",
      [body.app_id],
    );
    if (!appRows[0]) {
      res.status(404).json({ error: "app_not_found" });
      return;
    }

    // Suspension check — before access check so a suspended app never issues codes
    if (appRows[0].suspended_at !== null) {
      res.status(403).json({ error: "app_suspended" });
      return;
    }

    // The app's subdomain must be an https URL
    let subdomainUrl: URL;
    try {
      subdomainUrl = new URL(appRows[0].subdomain ?? "");
      if (subdomainUrl.protocol !== "https:") throw new Error("not_https");
    } catch {
      res
        .status(409)
        .json({ error: "app_not_configured", message: "App subdomain is not an https URL" });
      return;
    }

    // Always call ensureUser to refresh the stored email to the verified primary
    // address from Clerk (or "" if unverified / no primary).  This prevents the
    // duplicate-row bug where a stale users row sharing the same email would
    // block the real account from converting a pending grant.
    const clerkUserId = req.sscAuth.clerkUserId!;
    const internalUserId = await ensureUser(clerkUserId);
    const { rows: emailRows } = await pool.query<{ email: string }>(
      "SELECT email FROM users WHERE id = $1",
      [internalUserId],
    );
    const internalUserEmail = emailRows[0]?.email ?? "";

    // Check app_access; if absent, attempt pending-grant conversion
    const { rows: accessRows } = await pool.query(
      "SELECT 1 FROM app_access WHERE app_id = $1 AND user_id = $2",
      [body.app_id, internalUserId],
    );
    if (!accessRows[0]) {
      const storedEmail = internalUserEmail.toLowerCase().trim();
      if (storedEmail) {
        const { rows: pendingRows } = await pool.query<{ granted_by: string | null }>(
          "SELECT granted_by FROM pending_access WHERE app_id = $1 AND email = $2",
          [body.app_id, storedEmail],
        );
        if (pendingRows[0]) {
          // Convert: grant direct access and remove the pending row
          await pool.query(
            `INSERT INTO app_access (app_id, user_id, granted_by)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [body.app_id, internalUserId, pendingRows[0].granted_by],
          );
          await pool.query(
            "DELETE FROM pending_access WHERE app_id = $1 AND email = $2",
            [body.app_id, storedEmail],
          );
          // Fall through — user now has access
        } else {
          res.status(403).json({ error: "no_access" });
          return;
        }
      } else {
        res.status(403).json({ error: "no_access" });
        return;
      }
    }

    // Sanitize return path
    const returnPath = safeReturnPath(body.return ?? null);

    // Generate a one-time code (32 random bytes base64url); store only the hash
    const code = crypto.randomBytes(32).toString("base64url");
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");

    await pool.query(
      `INSERT INTO proxy_codes (code_hash, app_id, user_id, state, return_path, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + INTERVAL '60 seconds')`,
      [codeHash, body.app_id, internalUserId, body.state, returnPath],
    );

    // Build redirect_url from the stored subdomain — never from request input
    const callbackUrl = new URL("/__ssc/callback", subdomainUrl);
    callbackUrl.searchParams.set("code", code);
    callbackUrl.searchParams.set("state", body.state);
    callbackUrl.searchParams.set("return", returnPath);

    res.status(201).json({ redirect_url: callbackUrl.toString() });
  }),
);

// ── POST /exchange ────────────────────────────────────────────────────────────

proxyRouter.post(
  "/exchange",
  asyncHandler(async (req: Request, res: Response) => {
    // Auth: proxy token only — Clerk sessions and API keys are not accepted
    const appId = await resolveProxyAuth(req);
    if (!appId) {
      res.status(401).json({ error: "invalid_proxy_token" });
      return;
    }

    const body = req.body as { code?: string; state?: string };
    if (!body.code || !body.state) {
      res.status(401).json({ error: "invalid_code" });
      return;
    }

    const codeHash = crypto.createHash("sha256").update(body.code).digest("hex");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Lock the row for the duration of this transaction
      const { rows } = await client.query<{
        id: string;
        app_id: string;
        user_id: string;
        state: string;
        used_at: Date | null;
        expires_at: Date;
      }>(
        `SELECT id, app_id, user_id, state, used_at, expires_at
         FROM proxy_codes
         WHERE code_hash = $1
         FOR UPDATE`,
        [codeHash],
      );

      const rollbackAndDeny = async () => {
        await client.query("ROLLBACK");
        res.status(401).json({ error: "invalid_code" });
      };

      const row = rows[0];
      if (!row) { await rollbackAndDeny(); return; }
      if (row.app_id !== appId) { await rollbackAndDeny(); return; }
      if (row.used_at !== null) { await rollbackAndDeny(); return; }
      if (new Date() > new Date(row.expires_at)) { await rollbackAndDeny(); return; }

      // Constant-time state comparison
      const a = Buffer.from(body.state);
      const b = Buffer.from(row.state);
      const len = Math.max(a.length, b.length);
      const aPad = Buffer.concat([a, Buffer.alloc(len - a.length)]);
      const bPad = Buffer.concat([b, Buffer.alloc(len - b.length)]);
      const stateMatch = a.length === b.length && crypto.timingSafeEqual(aPad, bPad);
      if (!stateMatch) { await rollbackAndDeny(); return; }

      // App must still exist, not be deleted, and not be suspended
      const { rows: appRows } = await client.query<{
        id: string;
        suspended_at: Date | null;
      }>(
        "SELECT id, suspended_at FROM apps WHERE id = $1 AND deleted_at IS NULL",
        [appId],
      );
      if (!appRows[0]) { await rollbackAndDeny(); return; }
      if (appRows[0].suspended_at !== null) { await rollbackAndDeny(); return; }

      // User must still have access
      const { rows: accessRows } = await client.query(
        "SELECT 1 FROM app_access WHERE app_id = $1 AND user_id = $2",
        [appId, row.user_id],
      );
      if (!accessRows[0]) { await rollbackAndDeny(); return; }

      // Mark code as used
      await client.query(
        "UPDATE proxy_codes SET used_at = now() WHERE id = $1",
        [row.id],
      );

      // Fetch user identity
      const { rows: userRows } = await client.query<{ id: string; email: string }>(
        "SELECT id, email FROM users WHERE id = $1",
        [row.user_id],
      );

      await client.query("COMMIT");

      res.status(200).json({
        user_id: userRows[0].id,
        email: userRows[0].email,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }),
);

// ── GET /access ───────────────────────────────────────────────────────────────

proxyRouter.get(
  "/access",
  asyncHandler(async (req: Request, res: Response) => {
    // Auth: proxy token only
    const appId = await resolveProxyAuth(req);
    if (!appId) {
      res.status(401).json({ error: "invalid_proxy_token" });
      return;
    }

    const userId = req.query.user_id as string | undefined;

    // Non-UUID user_id → false (never a DB error)
    if (!userId || !isUuid(userId)) {
      res.status(200).json({ allowed: false });
      return;
    }

    const { rows } = await pool.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM app_access aa
         JOIN apps a ON a.id = aa.app_id
         WHERE aa.app_id = $1
           AND aa.user_id = $2
           AND a.deleted_at IS NULL
           AND a.suspended_at IS NULL
       ) AS allowed`,
      [appId, userId],
    );

    res.status(200).json({ allowed: rows[0].allowed });
  }),
);
