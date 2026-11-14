/**
 * requireAuth middleware
 *
 * Supports two authentication schemes:
 *   1. Clerk session JWT  — set by @clerk/express clerkMiddleware()
 *   2. SSC API key        — "Authorization: Bearer ssc_<token>"
 *
 * On success, attaches `req.sscAuth` and calls next().
 * On failure, returns 401.
 */

import { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { pool } from "../db";
import { hashApiKey, looksLikeApiKey } from "../lib/apiKeys";
import { safeErr } from "../lib/safeErr";

export interface SscAuth {
  type: "clerk" | "api_key";
  clerkUserId?: string;
  clerkOrgId?: string;
  clerkOrgRole?: string;
  internalOrgId?: string;
  /** users.id of the user who created this API key (undefined when key has no creator) */
  apiKeyCreatedBy?: string;
  /** Scopes granted to this API key (undefined for Clerk sessions) */
  apiKeyScopes?: string[];
}

declare global {
  namespace Express {
    interface Request {
      sscAuth?: SscAuth;
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // ── 1. Try API key ────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    if (looksLikeApiKey(token)) {
      const keyHash = hashApiKey(token);
      let rows: { org_id: string; created_by: string | null; scopes: string[] }[];
      try {
        ({ rows } = await pool.query<{ org_id: string; created_by: string | null; scopes: string[] }>(
          `SELECT org_id, created_by, scopes FROM api_keys
           WHERE key_hash = $1
             AND revoked_at IS NULL`,
          [keyHash],
        ));
      } catch (dbErr) {
        console.error("[requireAuth] db error", safeErr(dbErr));
        res.status(500).json({ error: "internal_error" });
        return;
      }
      if (rows.length === 0) {
        res.status(401).json({ error: "invalid_api_key" });
        return;
      }
      // Update last_used_at asynchronously (fire and forget)
      pool
        .query(
          "UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1",
          [keyHash],
        )
        .catch(() => {});

      req.sscAuth = {
        type: "api_key",
        internalOrgId: rows[0].org_id,
        apiKeyScopes: rows[0].scopes,
        ...(rows[0].created_by ? { apiKeyCreatedBy: rows[0].created_by } : {}),
      };
      next();
      return;
    }
  }

  // ── 2. Try Clerk session ──────────────────────────────────────────────────
  try {
    const clerkAuth = getAuth(req);
    if (clerkAuth?.userId) {
      req.sscAuth = {
        type: "clerk",
        clerkUserId: clerkAuth.userId,
        clerkOrgId: clerkAuth.orgId ?? undefined,
        clerkOrgRole: clerkAuth.orgRole ?? undefined,
      };
      next();
      return;
    }
  } catch {
    // clerkMiddleware was not mounted or Clerk is not initialised
    // — fall through to 401 below
  }

  // ── 3. Unauthenticated ────────────────────────────────────────────────────
  res.status(401).json({ error: "unauthenticated", reason: "no_credentials" });
}
