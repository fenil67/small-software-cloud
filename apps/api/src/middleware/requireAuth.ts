import { getAuth } from "@clerk/express";
import { Request, Response, NextFunction } from "express";

/**
 * Enforces that the request has a valid Clerk session.
 * Attach after clerkMiddleware() in the middleware chain.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  next();
}
