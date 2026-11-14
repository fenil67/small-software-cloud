/**
 * requireScope — per-route scope enforcement for API keys.
 *
 * Clerk sessions are always passed through (org-level rules apply as before).
 * API keys are checked against the scopes stored in api_keys.scopes.
 *
 * Scope semantics:
 *   - Every non-empty scope set implies "read" (read is free with any scope).
 *   - "deploy" and "manage" are independent; neither implies the other.
 *
 * Missing scope → 403 { error: "insufficient_scope", required: "<scope>" }.
 */

import { Request, Response, NextFunction } from "express";

export type Scope = "read" | "deploy" | "manage";

export function requireScope(scope: Scope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = req.sscAuth!;

    // Clerk sessions bypass scope checks entirely.
    if (auth.type === "clerk") {
      next();
      return;
    }

    const keyScopes = auth.apiKeyScopes ?? [];
    let allowed: boolean;

    if (scope === "read") {
      // Any non-empty scope set grants read.
      allowed = keyScopes.length > 0;
    } else {
      allowed = keyScopes.includes(scope);
    }

    if (allowed) {
      next();
    } else {
      res.status(403).json({ error: "insufficient_scope", required: scope });
    }
  };
}
