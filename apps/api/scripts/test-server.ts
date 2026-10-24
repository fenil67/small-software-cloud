/**
 * Minimal test server.
 * - Uses API-key auth only (no Clerk middleware needed)
 * - Stubs flyClient so no real Fly API calls are made
 * - Stubs deployRunner so deploys return quickly with predictable results
 * - Reads DATABASE_URL from env (point at ssc_test)
 */

// ── Safety: refuse to run against the Railway production database ─────────────
const _dbUrl = process.env.DATABASE_URL ?? "";
if (_dbUrl.includes("rlwy.net") || _dbUrl.includes("railway.app")) {
  console.error(
    "[test-server] FATAL: DATABASE_URL points at Railway production — aborting.\n" +
      "  Set DATABASE_URL to a local Postgres instance, e.g.:\n" +
      '  DATABASE_URL="postgres://fenilpatel@localhost:5432/ssc_test" npx ts-node ...',
  );
  process.exit(1);
}

// Must be set before any imports
process.env.FLY_API_TOKEN = "test-token";
process.env.FLY_ORG_SLUG = "test-org";
process.env.CLERK_SECRET_KEY = "sk_test_stubstubstubstub";
process.env.SSC_TEST = "1";

// ── Log capture (intercept console.error BEFORE any module imports) ───────────
// Section N drains these to verify no secret leaks in error logs.
const _recentErrorLogs: string[] = [];
const _origConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  _recentErrorLogs.push(
    args.map((a) => (typeof a === "string" ? a : String(a))).join(" "),
  );
  if (_recentErrorLogs.length > 200) _recentErrorLogs.shift();
  _origConsoleError(...args);
};

import crypto from "crypto";
import express, { Request, Response, NextFunction } from "express";
import { healthRouter } from "../src/routes/health";
import { appsRouter } from "../src/routes/apps";
import { deploymentsRouter } from "../src/routes/deployments";
import { deployStreamRouter } from "../src/routes/deployStream";
import { intakeRouter } from "../src/routes/intake";
import { apiKeysRouter } from "../src/routes/apiKeys";
import { authRouter } from "../src/routes/auth";
import { startReaper } from "../src/lib/reaper";
import { eventBus } from "../src/lib/eventBus";
import { safeErr } from "../src/lib/safeErr";
import { pool } from "../src/db";

// ── Stub deployRunner ─────────────────────────────────────────────────────────
// Override the module-level import used by intake.ts.
// We do this by patching require cache after imports resolve.
// intake.ts calls runDeploy({ deploymentId, appId, ... }) in setImmediate.
// We replace it so tests can control success/failure.

const deployRunnerModule = require("../src/services/deployRunner");

type DeployArgs = {
  deploymentId: string;
  appId: string;
  zipBuffer?: Buffer;
  githubUrl?: string;
  simulateFailure?: boolean;
};

let nextDeployMode: "success" | "failure" | "timeout" = "success";

export function setNextDeployMode(mode: "success" | "failure" | "timeout"): void {
  nextDeployMode = mode;
}

deployRunnerModule.runDeploy = async function (args: DeployArgs): Promise<void> {
  const { deploymentId, appId } = args;
  const mode = nextDeployMode;
  nextDeployMode = "success"; // reset

  const flyAppName = `ssc-test-${appId.slice(0, 8)}`;

  if (mode === "timeout") {
    // Just leave it in 'building' — reaper will time it out
    await pool.query(
      `UPDATE deployments SET status='building', started_at = now() - INTERVAL '20 minutes'
       WHERE id=$1`,
      [deploymentId],
    );
    return;
  }

  // Set fly_app_id on the app so subdomain works
  await pool.query("UPDATE apps SET fly_app_id=$1 WHERE id=$2", [flyAppName, appId]);

  // Short delay to simulate async work
  await new Promise((r) => setTimeout(r, 80));

  if (mode === "failure") {
    await pool.query(
      `UPDATE deployments SET status='failed',
         failure_stage='build',
         failure_message='Dockerfile build failed: unknown instruction RRUN',
         finished_at=now()
       WHERE id=$1`,
      [deploymentId],
    );
    eventBus.emit(deploymentId, {
      type: "error",
      stage: "build",
      message: "Dockerfile build failed: unknown instruction RRUN",
    });
    eventBus.emit(deploymentId, { type: "status", status: "failed" });
    eventBus.emit(deploymentId, { type: "done" });
  } else {
    const appHost = `${flyAppName}.fly.dev`;
    const appUrl = `https://${appHost}`;
    await pool.query(
      `UPDATE apps SET subdomain=$1 WHERE id=$2`,
      [appHost, appId],
    );
    await pool.query(
      `UPDATE deployments SET status='success', fly_machine_id='test-machine-1', finished_at=now()
       WHERE id=$1`,
      [deploymentId],
    );
    eventBus.emit(deploymentId, { type: "log", message: "Building image…" });
    eventBus.emit(deploymentId, { type: "log", message: "Deploy complete." });
    eventBus.emit(deploymentId, { type: "url", url: appUrl });
    eventBus.emit(deploymentId, { type: "status", status: "success" });
    eventBus.emit(deploymentId, { type: "done" });
  }
};

// ── Stub flyClient ────────────────────────────────────────────────────────────
const flyModule = require("../src/services/flyClient");
flyModule.createFlyApp = async () => {};
flyModule.allocateFlyIp = async () => "1.2.3.4";

// destroyFlyApp is configurable: normally succeeds; when flyErrorMode is enabled
// it throws a raw Axios-shaped error (with Authorization in config) so Section N
// can verify that safeErr strips credentials before they reach the log.
let _flyErrorMode = false;
flyModule.destroyFlyApp = async (_appName: string) => {
  if (_flyErrorMode) {
    // Simulate a Fly API 401 Axios error — this is the exact shape that would
    // appear if the interceptor in flyClient.ts were absent.
    const err = Object.assign(new Error("Request failed with status code 401"), {
      isAxiosError: true,
      config: {
        method: "delete",
        url: "https://api.machines.dev/v1/apps/test-app",
        headers: {
          Authorization: `Bearer ${process.env.FLY_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      },
      request: { _header: `DELETE /v1/apps/test-app HTTP/1.1\nAuthorization: Bearer ${process.env.FLY_API_TOKEN}\n` },
      response: { status: 401, data: { error: "unauthorized" } },
    });
    throw err;
  }
};

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Attach a request ID so the error middleware can echo it back
app.use((req: Request, _res: Response, next: NextFunction) => {
  (req as Request & { id: string }).id = crypto.randomUUID();
  next();
});

// Test-control endpoint: POST /test/set-deploy-mode { mode: "success"|"failure" }
app.post("/test/set-deploy-mode", (req, res) => {
  const { mode } = req.body as { mode?: string };
  if (mode === "success" || mode === "failure") {
    nextDeployMode = mode;
    res.json({ ok: true, mode });
  } else {
    res.status(400).json({ error: "invalid mode" });
  }
});

// Test-control endpoint: POST /test/set-fly-error { enabled: true|false }
// When enabled, destroyFlyApp throws a raw Axios error with credentials in config.
app.post("/test/set-fly-error", (req, res) => {
  _flyErrorMode = !!(req.body as { enabled?: boolean }).enabled;
  res.json({ ok: true, flyErrorMode: _flyErrorMode });
});

// Test-control endpoint: GET /test/drain-logs
// Returns and clears the captured console.error log lines.
app.get("/test/drain-logs", (_req, res) => {
  res.json({ logs: _recentErrorLogs.splice(0) });
});

// Test-control endpoint: GET /test/db-error — deliberately queries a nonexistent table
// Used by Section M to prove asyncHandler + error middleware returns 500 JSON
app.get("/test/db-error", async (_req: Request, _res: Response, next: NextFunction) => {
  try {
    await pool.query("SELECT * FROM _nonexistent_table_xyzzy");
  } catch (err) {
    next(err);
    return;
  }
});

// NOTE: no clerkMiddleware() — we only test API-key auth paths
app.use("/health", healthRouter);
app.use("/v1/auth", authRouter);
app.use("/v1/apps", appsRouter);
app.use("/v1/api-keys", apiKeysRouter);
app.use("/v1/deployments/intake", intakeRouter);
app.use("/v1/deployments", deployStreamRouter);
app.use("/v1/deployments", deploymentsRouter);
app.use((_req, res) => res.status(404).json({ error: "not_found" }));

// Final error middleware — catches anything forwarded via next(err)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  const requestId = (req as Request & { id?: string }).id ?? "unknown";
  console.error(`[test-server] unhandled error request_id=${requestId}:`, safeErr(err));
  if (!res.headersSent) {
    res.status(500).json({ error: "internal_error", request_id: requestId });
  }
});

startReaper();

const PORT = parseInt(process.env.TEST_PORT ?? "4099");
app.listen(PORT, () => {
  process.stdout.write(`[test-server] ready on :${PORT}\n`);
});

export { app };
