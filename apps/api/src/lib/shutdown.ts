/**
 * Graceful shutdown for SIGTERM (Railway sends this before stopping the container).
 *
 * On SIGTERM:
 *   1. Set _shuttingDown = true  → intake returns 503, /health returns 503.
 *   2. server.close()            → stop accepting new connections.
 *   3. Prune any stale entries from _activeDeploys (entries whose DB row is
 *      already terminal — left behind by edge-case crashes or double-registration).
 *   4. Wait up to waitMs for any in-flight deploys to finish on their own.
 *      waitMs is derived from RAILWAY_DEPLOYMENT_DRAINING_SECONDS at runtime:
 *        waitMs = max(0, (draining − 7) × 1000)
 *      If the env var is not set, we default to 5 s and log a warning.
 *   5. For any deploy still running: call its abort callback, which calls the
 *      deploy runner's internal fail() with stage="platform_update".
 *   6. Brief pause for abort handlers to persist to DB and emit final SSE events.
 *   7. pool.end() then process.exit(0).
 *
 * Railway grace period: Railway sends SIGTERM, then waits drainingSeconds before
 * sending SIGKILL.  The setting is called "Draining time" in Service → Settings →
 * Deployment teardown (also RAILWAY_DEPLOYMENT_DRAINING_SECONDS service variable).
 * The Railway docs do not document a default value.  Set Draining time to at
 * least 30 s in both Railway environments.
 */

import type { Server } from "http";
import type { Pool } from "pg";
import { safeErr } from "./safeErr";

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
 * Query the DB and remove any _activeDeploys entries whose deployment row is
 * already in a terminal state (success or failed) or does not exist.
 * Returns the number of stale entries pruned.
 *
 * Call this at the start of runGracefulShutdown to avoid waiting on deploys
 * that already finished but somehow did not call unregisterDeploy.
 */
export async function pruneFinishedDeploys(pool: Pool): Promise<number> {
  if (_activeDeploys.size === 0) return 0;
  const ids = [..._activeDeploys.keys()];
  const { rows } = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM deployments WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const inDb = new Map(rows.map((r) => [r.id, r.status]));
  let pruned = 0;
  for (const id of ids) {
    const status = inDb.get(id);
    if (status === "success" || status === "failed" || status === undefined) {
      console.warn(
        `[shutdown] pruning stale deploy registration: ${id}` +
        ` (status=${status ?? "not_found"})`,
      );
      _activeDeploys.delete(id);
      pruned++;
    }
  }
  return pruned;
}

export interface ShutdownOptions {
  /**
   * Override the computed wait time (ms).  Used by tests to inject a short
   * grace period without touching RAILWAY_DEPLOYMENT_DRAINING_SECONDS.
   */
  gracePeriodMs?: number;
  /** Skip server.close() — used by tests that share a live server. */
  skipClose?: boolean;
  /** Skip pool.end() — used by tests that need the pool afterwards. */
  skipPoolEnd?: boolean;
  /** Skip process.exit(0) — used by tests to avoid killing the process. */
  skipExit?: boolean;
}

/**
 * SIGTERM handler.  Exported from index.ts as:
 *   process.on("SIGTERM", () => { void runGracefulShutdown(server, pool); });
 *
 * Idempotent — a second SIGTERM while shutting down is a no-op.
 * Pass options to override behaviour in tests.
 */
export async function runGracefulShutdown(
  server: Server | null,
  pool: Pool | null,
  options?: ShutdownOptions,
): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log("[shutdown] SIGTERM received — stopping new deploys");

  // Stop accepting new HTTP connections (in-flight requests continue).
  if (!options?.skipClose) server?.close();

  // Prune stale entries before waiting so we do not delay for already-finished deploys.
  if (pool) {
    await pruneFinishedDeploys(pool).catch((err) =>
      console.error("[shutdown] prune error:", safeErr(err)),
    );
  }

  // Compute how long to wait for in-flight deploys to finish on their own.
  let waitMs: number;
  if (options?.gracePeriodMs !== undefined) {
    waitMs = options.gracePeriodMs;
    console.log(`[shutdown] grace period override — waiting up to ${waitMs} ms`);
  } else {
    const draining = parseInt(process.env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS ?? "", 10);
    if (Number.isFinite(draining) && draining > 0) {
      waitMs = Math.max(0, (draining - 7) * 1000);
      console.log(
        `[shutdown] RAILWAY_DEPLOYMENT_DRAINING_SECONDS=${draining}` +
        ` — waiting up to ${waitMs} ms for in-flight deploys`,
      );
    } else {
      waitMs = 5_000;
      console.warn(
        "[shutdown] RAILWAY_DEPLOYMENT_DRAINING_SECONDS is not set — waiting only 5 s. " +
        "Set Draining time ≥ 30 s in Railway Service → Settings → Deployment teardown.",
      );
    }
  }

  // Wait for in-flight deploys to finish, up to waitMs.
  if (_activeDeploys.size > 0) {
    console.log(
      `[shutdown] ${_activeDeploys.size} deploy(s) in progress — waiting up to ${waitMs} ms`,
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
    console.log("[shutdown] waiting for abort handlers to flush");
    await new Promise<void>((r) => setTimeout(r, 1_000));
  }

  // Close DB pool.
  if (!options?.skipPoolEnd && pool) {
    try {
      await pool.end();
    } catch (err) {
      console.error("[shutdown] pool.end() error:", safeErr(err));
    }
  }

  console.log("[shutdown] complete — exiting");
  if (!options?.skipExit) process.exit(0);
}

// ── Test-only helpers ─────────────────────────────────────────────────────────
// Used by test-server.ts to simulate SIGTERM effects without calling process.exit.

/** FOR TESTS ONLY. Sets the shutdown flag without closing the server or pool. */
export function setShuttingDownForTest(value: boolean): void {
  _shuttingDown = value;
}
