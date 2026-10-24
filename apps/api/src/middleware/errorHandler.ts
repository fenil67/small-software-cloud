import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { safeErr } from "../lib/safeErr";

export function requestIdMiddleware(req: Request, _res: Response, next: NextFunction): void {
  (req as Request & { id: string }).id = crypto.randomUUID();
  next();
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandlerMiddleware(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const reqId = (req as Request & { id?: string }).id ?? "unknown";
  console.error(`[error] reqId=${reqId}`, safeErr(err));
  if (!res.headersSent) {
    res.status(500).json({ error: "internal_error", request_id: reqId });
  }
}
