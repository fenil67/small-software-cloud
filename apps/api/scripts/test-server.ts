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
      '  DATABASE_URL="postgres://postgres@localhost:5433/ssc_test" npx ts-node ...',
  );
  process.exit(1);
}

// Must be set before any imports
process.env.FLY_API_TOKEN = "test-token";
process.env.FLY_ORG_SLUG = "test-org";
process.env.CLERK_SECRET_KEY = "sk_test_fake";
process.env.SSC_TEST = "1";
// Proxy integration env — fake digest-pinned image and local URLs satisfy
// the startup validation in index.ts (not used here, but deployRunner reads them).
process.env.PROXY_IMAGE = `registry.fly.io/ssc-proxy@sha256:${"a".repeat(64)}`;
const _testPort = process.env.TEST_PORT ?? "4099";
process.env.API_PUBLIC_URL = `http://localhost:${_testPort}`;
process.env.WEB_URL = `http://localhost:${_testPort}`;
process.env.SSC_VERIFY_BASE_URL = `http://localhost:${_testPort}`;
// Keep verification fast in tests (1 s timeout, 100 ms poll)
process.env.SSC_VERIFY_TIMEOUT_MS = "1000";

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
import { startReaper, reapOrphanedFlyApps, reapExpiredProxyCodes } from "../src/lib/reaper";
import { eventBus } from "../src/lib/eventBus";
import { pool } from "../src/db";
import { requestIdMiddleware, errorHandlerMiddleware } from "../src/middleware/errorHandler";

// ── Fake flyctl binary ────────────────────────────────────────────────────────
// Prepended to PATH so runFlyctlDeploy in the real deployRunner finds it.
// Default: exit 0 (success). Sections S and T toggle via POST /test/set-flyctl-mode.
// When called with "secrets" as the first arg, stdin is captured to a file so
// AE tests can verify the proxy token is delivered via stdin, not argv.
const _fakeFlyctlDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssc-test-flyctl-"));
const _fakeFlyctlBin = path.join(_fakeFlyctlDir, "flyctl");
const _flyctlArgvFile = path.join(_fakeFlyctlDir, "flyctl-argv");
const _flyctlStdinFile = path.join(_fakeFlyctlDir, "flyctl-stdin");
// Full calls log — APPENDED on every invocation so argv from every call is visible,
// not just the last one.  One line per invocation (space-joined args).
const _flyctlArgvLog = path.join(_fakeFlyctlDir, "flyctl-argv-log");

function writeFlyctlScript(exitCode: number, stdoutCmd?: string): void {
  // The "secrets" branch always exits 0 — failure modes only apply to other
  // subcommands (e.g. "deploy").  This matches real flyctl behaviour where
  // secrets import is a separate, independent call.
  const script = `#!/bin/sh
echo "$@" > ${_flyctlArgvFile}
printf '%s\\n' "$*" >> ${_flyctlArgvLog}
if [ "$1" = "secrets" ]; then
  cat > ${_flyctlStdinFile}
  exit 0
fi
${stdoutCmd ? stdoutCmd + "\n" : ""}exit ${exitCode}
`;
  fs.writeFileSync(_fakeFlyctlBin, script, { mode: 0o755 });
}
writeFlyctlScript(0);
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

interface FlyCall { fn: string; arg: string; body?: Record<string, unknown> }
const _flyCallLog: FlyCall[] = [];

let _checkExistsResult = true;
let _destroyFailuresRemaining = 0;
let _flyErrorMode = false;
let _egressFailMode = false;
let _listMachinesResult: Array<{ id: string; state?: string }> = [{ id: "test-machine-1" }];

flyModule.createFlyApp = async (name: string, orgSlug: string, network: string) => {
  _flyCallLog.push({ fn: "createFlyApp", arg: name, body: { app_name: name, org_slug: orgSlug, network } });
};
flyModule.allocateFlyIp = async () => "1.2.3.4";
flyModule.checkFlyAppExists = async (name: string): Promise<boolean> => {
  _flyCallLog.push({ fn: "checkFlyAppExists", arg: name });
  return _checkExistsResult;
};
flyModule.createEgressPolicy = async (appName: string) => {
  _flyCallLog.push({ fn: "createEgressPolicy", arg: appName, body: flyModule.EGRESS_POLICY_BODY });
  if (_egressFailMode) throw new Error("network policy creation failed (test)");
};
flyModule.listMachines = async (appName: string) => {
  _flyCallLog.push({ fn: "listMachines", arg: appName });
  return [..._listMachinesResult];
};
flyModule.stopMachine = async (appName: string, machineId: string) => {
  _flyCallLog.push({ fn: "stopMachine", arg: appName, body: { machineId } });
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

// ── Clerk auth shim ───────────────────────────────────────────────────────────
// TEST-ONLY: a request header "x-test-clerk-user-id" makes requireAuth treat
// the request as a Clerk session for that clerk user id.
// This patch is applied here, before proxy.ts is loaded (via require() below),
// so the proxy router's /codes route captures the patched function.
// This header check MUST NOT exist in src/.
{
  const _raMod = require("../src/middleware/requireAuth") as {
    requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => void;
  };
  const _origRA = _raMod.requireAuth;
  _raMod.requireAuth = function testRequireAuth(req, res, next) {
    const h = req.headers["x-test-clerk-user-id"];
    const clerkUserId = Array.isArray(h) ? h[0] : h;
    if (typeof clerkUserId === "string" && clerkUserId) {
      const orgIdH = req.headers["x-test-clerk-org-id"];
      const orgRoleH = req.headers["x-test-clerk-org-role"];
      const clerkOrgId = Array.isArray(orgIdH) ? orgIdH[0] : (orgIdH as string | undefined);
      const clerkOrgRole = Array.isArray(orgRoleH) ? orgRoleH[0] : (orgRoleH as string | undefined);
      req.sscAuth = {
        type: "clerk",
        clerkUserId,
        ...(clerkOrgId ? { clerkOrgId } : {}),
        ...(clerkOrgRole ? { clerkOrgRole } : {}),
      };
      next();
      return;
    }
    _origRA(req, res, next);
  };
}

// Load routers that depend on requireAuth AFTER the patch above.
// Must use require() here — import statements are hoisted before this body runs.
const { proxyRouter } = require("../src/routes/proxy") as typeof import("../src/routes/proxy");
const { appAccessRouter } = require("../src/routes/appAccess") as typeof import("../src/routes/appAccess");

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

// POST /test/set-flyctl-mode { mode: "success"|"failure"|"failure-with-token" }
// Rewrites the fake flyctl binary.
// "failure-with-token": echoes FLY_API_TOKEN to stdout then exits 1 — used by
// Section U3 to verify scrubSecrets strips the token from outputLines before
// it reaches the stored failure_message or SSE error event.
app.post("/test/set-flyctl-mode", (req, res) => {
  const { mode } = req.body as { mode?: string };
  if (mode === "failure") {
    writeFlyctlScript(1);
  } else if (mode === "failure-with-token") {
    // flyctlEnv() passes FLY_API_TOKEN; fake flyctl echoes it then fails
    writeFlyctlScript(1, 'echo "unauthorized token=$FLY_API_TOKEN"');
  } else {
    writeFlyctlScript(0);
  }
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

// POST /test/set-egress-fail { fail: bool }
// When enabled, createEgressPolicy throws — used by AE7 to verify DeployError at "provision".
app.post("/test/set-egress-fail", (req, res) => {
  _egressFailMode = !!(req.body as { fail?: boolean }).fail;
  res.json({ ok: true, egressFailMode: _egressFailMode });
});

// POST /test/set-machines { machines: [{ id: string }] }
// Controls the list returned by listMachines (default: [{ id: "test-machine-1" }]).
app.post("/test/set-machines", (req, res) => {
  const { machines } = req.body as { machines?: Array<{ id: string }> };
  _listMachinesResult = machines ?? [];
  res.json({ ok: true });
});

// GET /test/get-flyctl-capture — returns last argv and stdin captured by fake flyctl
app.get("/test/get-flyctl-capture", (_req, res) => {
  const argv = fs.existsSync(_flyctlArgvFile) ? fs.readFileSync(_flyctlArgvFile, "utf8").trim() : "";
  const stdin = fs.existsSync(_flyctlStdinFile) ? fs.readFileSync(_flyctlStdinFile, "utf8") : "";
  res.json({ argv, stdin });
});

// POST /test/clear-flyctl-capture — clears all capture files including the full calls log
app.post("/test/clear-flyctl-capture", (_req, res) => {
  try { fs.unlinkSync(_flyctlArgvFile); } catch { /* ok */ }
  try { fs.unlinkSync(_flyctlStdinFile); } catch { /* ok */ }
  try { fs.unlinkSync(_flyctlArgvLog); } catch { /* ok */ }
  res.json({ ok: true });
});

// GET /test/get-flyctl-calls — returns every flyctl invocation's argv since last clear
// { calls: string[], stdin: string }
// calls: one entry per invocation (space-joined args, in order)
// stdin: content written to the most recent "secrets import" stdin pipe
app.get("/test/get-flyctl-calls", (_req, res) => {
  const calls = fs.existsSync(_flyctlArgvLog)
    ? fs.readFileSync(_flyctlArgvLog, "utf8").split("\n").filter(Boolean)
    : [];
  const stdin = fs.existsSync(_flyctlStdinFile)
    ? fs.readFileSync(_flyctlStdinFile, "utf8")
    : "";
  res.json({ calls, stdin });
});

// POST /test/gen-fly-toml { appName, appId, kind?, appPort? }
// Calls generateDeployFiles in-process and returns generated fly.toml (and nginx conf
// for static).  kind: "node"|"python"|"static"|"dockerfile" (default "node").
// appPort is passed through for the "dockerfile" kind to test port pass-through.
app.post("/test/gen-fly-toml", async (req, res) => {
  const { appName, appId, kind, appPort } = req.body as {
    appName?: string; appId?: string; kind?: string; appPort?: number;
  };
  if (!appName || !appId) { res.status(400).json({ error: "appName and appId required" }); return; }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssc-gen-toml-"));
  try {
    const { generateDeployFiles } = require("../src/services/dockerfileGen") as typeof import("../src/services/dockerfileGen");
    type AppType = Parameters<typeof generateDeployFiles>[2];
    const appType: AppType =
      kind === "static"
        ? { kind: "static" }
        : kind === "python"
        ? { kind: "python", server: "gunicorn", entrypoint: "app:app" }
        : kind === "dockerfile"
        ? { kind: "dockerfile" }
        : { kind: "node", packageManager: "npm", startCommand: "node index.js" };

    if (kind === "static") {
      fs.writeFileSync(path.join(tmpDir, "index.html"), "<h1>test</h1>");
    }
    if (kind === "python") {
      fs.writeFileSync(path.join(tmpDir, "requirements.txt"), "flask\n");
    }
    // For "dockerfile", generateDeployFiles only writes fly.toml — no Dockerfile needed.

    await generateDeployFiles(tmpDir, appName, appType, appId, typeof appPort === "number" ? appPort : undefined);

    const flyToml = fs.readFileSync(path.join(tmpDir, "fly.toml"), "utf8");
    const nginxConf = kind === "static" && fs.existsSync(path.join(tmpDir, "ssc-nginx.conf"))
      ? fs.readFileSync(path.join(tmpDir, "ssc-nginx.conf"), "utf8")
      : undefined;
    res.json({ flyToml, ...(nginxConf ? { nginxConf } : {}) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
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

// POST /test/run-proxy-code-reaper
// Runs reapExpiredProxyCodes() — used by AB tests to exercise the cleanup path.
app.post("/test/run-proxy-code-reaper", async (_req, res) => {
  try {
    const deleted = await reapExpiredProxyCodes();
    res.json({ ok: true, deleted });
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

// ── Fake proxy verification endpoints (AE tests) ──────────────────────────────
// When real deployRunner runs, verifyProxy polls /__ssc/health and GET / on
// SSC_VERIFY_BASE_URL (= this test server).  These routes simulate the proxy
// sidecar's responses; mode is controlled via POST /test/set-verify-mode.

let _verifyMode: "success" | "missing-proxy-header" | "wrong-redirect" | "down" = "success";

app.post("/test/set-verify-mode", (req, res) => {
  const { mode } = req.body as { mode?: string };
  if (mode === "success" || mode === "missing-proxy-header" || mode === "wrong-redirect" || mode === "down") {
    _verifyMode = mode;
  }
  res.json({ ok: true, verifyMode: _verifyMode });
});

app.get("/__ssc/health", (_req, res) => {
  if (_verifyMode === "down") { res.status(503).json({}); return; }
  if (_verifyMode === "missing-proxy-header") { res.status(200).json({ ok: true }); return; }
  // success and wrong-redirect both pass the health check
  res.set("x-ssc-proxy", "1").status(200).json({ ok: true });
});

// GET / — fake proxy root redirect for verification
// In test mode verifyProxy checks only that Location starts with WEB_URL+"/access?app=",
// so a fixed placeholder UUID is fine.
const _FAKE_APP_UUID = "00000000-0000-0000-0000-000000000000";
app.get("/", (req, res, next) => {
  // Only intercept requests that look like the proxy verification check
  if (!req.headers["accept"]?.includes("text/html") || _verifyMode === "down") {
    next(); return;
  }
  const webUrl = process.env.WEB_URL ?? "";
  if (_verifyMode === "wrong-redirect") {
    res.set("x-ssc-proxy", "1").redirect(302, `${webUrl}/wrong-path?app=${_FAKE_APP_UUID}`);
    return;
  }
  // success
  res.set("x-ssc-proxy", "1").redirect(302, `${webUrl}/access?app=${_FAKE_APP_UUID}`);
});

// NOTE: no clerkMiddleware() — we only test API-key auth paths
app.use("/health", healthRouter);
app.use("/v1/auth", authRouter);
app.use("/v1/apps/:id/access", appAccessRouter);
app.use("/v1/apps", appsRouter);
app.use("/v1/api-keys", apiKeysRouter);
app.use("/v1/deployments/intake", intakeRouter);
app.use("/v1/deployments", deployStreamRouter);
app.use("/v1/deployments", deploymentsRouter);
app.use("/v1/proxy", proxyRouter);
app.use((_req, res) => res.status(404).json({ error: "not_found" }));

// Final error middleware — catches anything forwarded via next(err)
app.use(errorHandlerMiddleware);

startReaper();

const PORT = parseInt(process.env.TEST_PORT ?? "4099");
app.listen(PORT, () => {
  process.stdout.write(`[test-server] ready on :${PORT}\n`);
});

export { app };
