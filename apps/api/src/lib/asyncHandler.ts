import { Request, Response, NextFunction } from "express";

/**
 * Wraps an async Express route handler or middleware so that any rejected
 * promise is forwarded to Express's next(err) error handler.
 *
 * Express 4 does not do this automatically: an async handler that throws
 * without calling next(err) leaves the client connection open forever.
 * Wrapping with asyncHandler guarantees the final error middleware always
 * receives the error and can return a 500 JSON response.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
