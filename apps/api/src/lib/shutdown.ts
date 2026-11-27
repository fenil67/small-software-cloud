/**
 * Graceful shutdown for SIGTERM (Railway sends this before stopping the container).
 *
 * On SIGTERM:
 *   1. Set _shuttingDown = true  → intake returns 503, /health returns 503.
 *   2. server.close()            → stop accepting new connections.
 *   3. Wait up to (SHUTDOWN_GRACE_MS − SHUTDOWN_SAFETY_MARGIN_MS) for any
 *      in-flight deploys to finish on their own.
 *   4. For any deploy still running: call its abort callback, which calls the
 *      deploy runner's internal fail() with stage="platform_update".
 *   5. Brief pause for abort handlers to persist to DB and emit final SSE events.
 *   6. pool.end() then process.exit(0).
 *
 * Railway grace period: Railway sends SIGTERM, then waits drainingSeconds before
 * sending SIGKILL.  The setting is called "Draining time" in Service → Settings →
 * Deployment teardown (also RAILWAY_DEPLOYMENT_DRAINING_SECONDS service variable).
 * The Railway docs do not document a default value for drainingSeconds.
 * We default SHUTDOWN_GRACE_MS to 25 000 ms (25 s).  Set "Draining time" to at
 * least 30 s in both Railway environments so Railway does not kill the process
 * before our grace window expires.  Set SHUTDOWN_GRACE_MS if you need longer.
 */

import type { Server } from "http";
import type { Pool } from "pg";
import { safeErr } from "./safeErr";

const SHUTDOWN_GRACE_MS = (() => {
  const v = parseInt(process.env.SHUTDOWN_GRACE_MS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 25_000;
})();
const SHUTDOWN_SAFETY_MARGIN_MS = 2_000;

let _shuttingDown = false;

/**
 * Called by intake routes to block new deploys during shutdown.
 * Also used by /health to signal Railway's load-balancer to stop sending traffic.
 */
export function isShuttingDown(): boolean {
  return _shuttingDown;
}

/**
 * AbortFn is called by runGracefulShutdown when the grace period expires.
 * It receives the failure stage and user-safe message to persist to the DB.
 */
type AbortFn = (stage: string, message: string) => void;

const _activeDeploys = new Map<string, AbortFn>();

/** Called by runDeploy at the start of each deployment. */
export function registerDeploy(deploymentId: string, abort: AbortFn): void {
  _activeDeploys.set(deploymentId, abort);
}

/** Called by runDeploy in its finally block. */
export function unregisterDeploy(deploymentId: string): void {
  _activeDeploys.delete(deploymentId);
}

/** Number of currently-registered in-flight deploys. */
export function activeDeployCount(): number {
  return _activeDeploys.size;
}

/**
 * SIGTERM handler.  Exported from index.ts as:
 *   process.on("SIGTERM", () => { void runGracefulShutdown(server, pool); });
 *
 * Idempotent — a second SIGTERM while shutting down is a no-op.
 */
export async function runGracefulShutdown(server: Server, pool: Pool): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log("[shutdown] SIGTERM received — stopping new deploys");

  // Stop accepting new HTTP connections (in-flight requests continue).
  server.close();

  // Wait for in-flight deploys to finish, up to the safe window.
  if (_activeDeploys.size > 0) {
    const waitMs = Math.max(0, SHUTDOWN_GRACE_MS - SHUTDOWN_SAFETY_MARGIN_MS);
    console.log(
      `[shutdown] ${_activeDeploys.size} deploy(s) in progress — ` +
      `waiting up to ${waitMs} ms`,
    );
    await Promise.race([
      // Resolves as soon as all deploys unregister themselves.
      new Promise<void>((resolve) => {
        const check = () => {
          if (_activeDeploys.size === 0) { resolve(); return; }
          setTimeout(check, 200);
        };
        check();
      }),
      new Promise<void>((r) => setTimeout(r, waitMs)),
    ]);
  }

  // Abort any deploy that is still running after the grace window.
  if (_activeDeploys.size > 0) {
    console.log(`[shutdown] aborting ${_activeDeploys.size} remaining deploy(s)`);
    for (const [id, abort] of _activeDeploys) {
      console.log(`[shutdown] aborting deploy ${id}`);
      try {
        abort(
          "platform_update",
          "Utir was updating during your deploy. Please deploy again.",
        );
      } catch (err) {
        console.error(`[shutdown] abort error for ${id}:`, safeErr(err));
      }
    }
    // Brief wait for abort handlers to persist to DB and emit final SSE events.
    await new Promise<void>((r) => setTimeout(r, 1_000));
  }

  // Close DB pool.
  try {
    await pool.end();
  } catch (err) {
    console.error("[shutdown] pool.end() error:", safeErr(err));
  }

  console.log("[shutdown] complete — exiting");
  process.exit(0);
}

// ── Test-only helpers ─────────────────────────────────────────────────────────
// Used by test-server.ts to simulate SIGTERM effects without calling process.exit.

/** FOR TESTS ONLY. Sets the shutdown flag without closing the server or pool. */
export function setShuttingDownForTest(value: boolean): void {
  _shuttingDown = value;
}

/** FOR TESTS ONLY. Calls abort on every active deploy, same as the grace-period expiry path. */
export function abortAllActiveDeploysForTest(): void {
  for (const [id, abort] of _activeDeploys) {
    try {
      abort(
        "platform_update",
        "Utir was updating during your deploy. Please deploy again.",
      );
    } catch (err) {
      console.error(`[shutdown-test] abort error for ${id}:`, safeErr(err));
    }
  }
}
