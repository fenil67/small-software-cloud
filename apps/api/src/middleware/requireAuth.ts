import { getAuth } from "@clerk/express";
import { Request, Response, NextFunction } from "express";

/**
 * Enforces that the request has a valid Clerk session.
 * Attach after clerkMiddleware() in the middleware chain.
 *
 * On failure, returns structured JSON so callers know whether the token is
 * missing, expired, or otherwise invalid — avoids silent "internal_error".
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = getAuth(req);
  if (!auth.userId) {
    // debug() returns the raw authenticate-context including reason + message
    const debugData = auth.debug() as Record<string, unknown>;
    const reason = (debugData.reason as string | undefined) ?? "unauthenticated";
    const message = (debugData.message as string | undefined) ?? undefined;

    res.status(401).json({
      error: "unauthenticated",
      reason,
      ...(message ? { message } : {}),
    });
    return;
  }
  next();
}
