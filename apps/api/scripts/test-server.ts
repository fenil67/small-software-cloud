/**
 * Minimal test server.
 * - Uses API-key auth only (no Clerk middleware needed)
 * - Stubs flyClient so no real Fly API calls are made
 * - Stubs deployRunner so deploys return quickly with predictable results
 * - Real deploy mode: POST /test/set-real-deploy switches to actual deployRunner
 *   (fly stubs + fake flyctl binary stay active in this process)
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
process.env.CLERK_SECRET_KEY = "sk_test_fake";
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

import os from "os";
import path from "path";
import fs from "fs";
import express, { Request, Response, NextFunction } from "express";
import { healthRouter } from "../src/routes/health";
import { appsRouter } from "../src/routes/apps";
import { deploymentsRouter } from "../src/routes/deployments";
import { deployStreamRouter } from "../src/routes/deployStream";
import { intakeRouter } from "../src/routes/intake";
import { apiKeysRouter } from "../src/routes/apiKeys";
import { authRouter } from "../src/routes/auth";
import { startReaper, reapOrphanedFlyApps } from "../src/lib/reaper";
import { eventBus } from "../src/lib/eventBus";
import { pool } from "../src/db";
import { requestIdMiddleware, errorHandlerMiddleware } from "../src/middleware/errorHandler";

// ── Fake flyctl binary ────────────────────────────────────────────────────────
// Prepended to PATH so runFlyctlDeploy in the real deployRunner finds it.
// Default: exit 0 (success). Sections S and T toggle via POST /test/set-flyctl-mode.
const _fakeFlyctlDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssc-test-flyctl-"));
const _fakeFlyctlBin = path.join(_fakeFlyctlDir, "flyctl");
fs.writeFileSync(_fakeFlyctlBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
process.env.PATH = _fakeFlyctlDir + ":" + (process.env.PATH ?? "");

// ── Stub deployRunner ─────────────────────────────────────────────────────────
// Override the module-level import used by intake.ts.
// Save the real runDeploy BEFORE patching so /test/set-real-deploy can restore it.
// When _realDeployEnabled = true the stub delegates to _realRunDeploy; the fly
// stubs and fake flyctl remain active in this process, so Sections S and T get
// real lifecycle behaviour with controllable Fly API responses.

const deployRunnerModule = require("../src/services/deployRunner");

type DeployArgs = {
  deploymentId: string;
  appId: string;
  zipBuffer?: Buffer;
  githubUrl?: string;
  simulateFailure?: boolean;
};

const _realRunDeploy = deployRunnerModule.runDeploy as (args: DeployArgs) => Promise<void>;
let _realDeployEnabled = false;

let nextDeployMode: "success" | "failure" | "timeout" = "success";

export function setNextDeployMode(mode: "success" | "failure" | "timeout"): void {
  nextDeployMode = mode;
}

deployRunnerModule.runDeploy = async function (args: DeployArgs): Promise<void> {
  if (_realDeployEnabled) {
    return _realRunDeploy(args);
  }

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
// All three Fly functions record calls to _flyCallLog.
// destroyFlyApp supports configurable failure modes for Sections S and T:
//   _destroyFailuresRemaining = 0  → succeed (default)
//   _destroyFailuresRemaining = -1 → always fail (T2: always-fail)
//   _destroyFailuresRemaining = N  → fail the next N calls then succeed (T1: fail-2-then-succeed)
// Failures embed process.env.FLY_API_TOKEN in the message so T2 can verify safeErr scrubs it.
// _flyErrorMode (Section N) takes precedence and throws an Axios-shaped error.

const flyModule = require("../src/services/flyClient");

interface FlyCall { fn: string; arg: string }
const _flyCallLog: FlyCall[] = [];

let _checkExistsResult = true;
let _destroyFailuresRemaining = 0;
let _flyErrorMode = false;

flyModule.createFlyApp = async (name: string) => {
  _flyCallLog.push({ fn: "createFlyApp", arg: name });
};
flyModule.allocateFlyIp = async () => "1.2.3.4";
flyModule.checkFlyAppExists = async (name: string): Promise<boolean> => {
  _flyCallLog.push({ fn: "checkFlyAppExists", arg: name });
  return _checkExistsResult;
};
flyModule.destroyFlyApp = async (appName: string) => {
  _flyCallLog.push({ fn: "destroyFlyApp", arg: appName });

  if (_flyErrorMode) {
    // Section N: Axios-shaped 401 to exercise safeErr credential stripping
    const err = Object.assign(new Error("Request failed with status code 401"), {
      isAxiosError: true,
      config: {
        method: "delete",
        url: "https://api.machines.dev/v1/apps/" + appName,
        headers: {
          Authorization: `Bearer ${process.env.FLY_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      },
      request: { _header: `DELETE /v1/apps/${appName} HTTP/1.1\nAuthorization: Bearer ${process.env.FLY_API_TOKEN}\n` },
      response: { status: 401, data: { error: "unauthorized" } },
    });
    throw err;
  }

  if (_destroyFailuresRemaining === -1) {
    // Always fail — message embeds token so safeErr scrubbing is exercised by T2
    throw new Error(`Fly API error token=${process.env.FLY_API_TOKEN} unauthorized app=${appName}`);
  }
  if (_destroyFailuresRemaining > 0) {
    _destroyFailuresRemaining--;
    throw new Error(`Fly API error token=${process.env.FLY_API_TOKEN} unauthorized app=${appName}`);
  }
  // else: succeed (no-op)
};

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Attach a request ID so the error middleware can echo it back
app.use(requestIdMiddleware);

// ── Test-control endpoints ────────────────────────────────────────────────────

// POST /test/set-deploy-mode { mode: "success"|"failure"|"timeout" }
app.post("/test/set-deploy-mode", (req, res) => {
  const { mode } = req.body as { mode?: string };
  if (mode === "success" || mode === "failure" || mode === "timeout") {
    nextDeployMode = mode;
    res.json({ ok: true, mode });
  } else {
    res.status(400).json({ error: "invalid mode" });
  }
});

// POST /test/set-real-deploy { enabled: bool }
// Switch between fast stub deployRunner and the real deployRunner.
// Fly stubs + fake flyctl are still active in this process.
app.post("/test/set-real-deploy", (req, res) => {
  _realDeployEnabled = !!(req.body as { enabled?: boolean }).enabled;
  res.json({ ok: true, realDeployEnabled: _realDeployEnabled });
});

// POST /test/set-flyctl-mode { mode: "success"|"failure" }
// Rewrites the fake flyctl binary to exit 0 or 1.
app.post("/test/set-flyctl-mode", (req, res) => {
  const { mode } = req.body as { mode?: string };
  const script = mode === "failure" ? "#!/bin/sh\nexit 1\n" : "#!/bin/sh\nexit 0\n";
  fs.writeFileSync(_fakeFlyctlBin, script, { mode: 0o755 });
  res.json({ ok: true, mode: mode ?? "success" });
});

// GET /test/fly-call-log — returns all recorded Fly API calls
app.get("/test/fly-call-log", (_req, res) => {
  res.json({ calls: [..._flyCallLog] });
});

// POST /test/reset-fly-call-log — clears the call log
app.post("/test/reset-fly-call-log", (_req, res) => {
  _flyCallLog.length = 0;
  res.json({ ok: true });
});

// POST /test/set-fly-destroy-failures { times: number }
// 0 = succeed; -1 = always fail; N = fail next N calls then succeed.
app.post("/test/set-fly-destroy-failures", (req, res) => {
  const { times } = req.body as { times?: number };
  _destroyFailuresRemaining = typeof times === "number" ? times : 0;
  res.json({ ok: true, destroyFailuresRemaining: _destroyFailuresRemaining });
});

// POST /test/set-fly-check-exists { result: bool }
// Controls what checkFlyAppExists returns (default: true).
app.post("/test/set-fly-check-exists", (req, res) => {
  const { result } = req.body as { result?: boolean };
  _checkExistsResult = result !== false;
  res.json({ ok: true, checkExistsResult: _checkExistsResult });
});

// POST /test/set-fly-error { enabled: true|false }
// When enabled, destroyFlyApp throws a raw Axios error with credentials in config.
// Used by Section N to verify safeErr strips credentials before they reach the log.
app.post("/test/set-fly-error", (req, res) => {
  _flyErrorMode = !!(req.body as { enabled?: boolean }).enabled;
  res.json({ ok: true, flyErrorMode: _flyErrorMode });
});

// POST /test/run-reaper
// Runs reapOrphanedFlyApps() directly in this process (uses patched flyClient).
// Returns { destroyed: number }.
app.post("/test/run-reaper", async (_req, res) => {
  try {
    const destroyed = await reapOrphanedFlyApps();
    res.json({ ok: true, destroyed });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /test/drain-logs
// Returns and clears the captured console.error log lines.
app.get("/test/drain-logs", (_req, res) => {
  res.json({ logs: _recentErrorLogs.splice(0) });
});

// GET /test/db-error — deliberately queries a nonexistent table
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
app.use(errorHandlerMiddleware);

startReaper();

const PORT = parseInt(process.env.TEST_PORT ?? "4099");
app.listen(PORT, () => {
  process.stdout.write(`[test-server] ready on :${PORT}\n`);
});

export { app };
