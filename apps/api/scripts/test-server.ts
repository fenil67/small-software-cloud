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
// PLATFORM_ADMIN_CLERK_IDS: use env override if provided, otherwise default to
// a single well-known test admin ID used by AF tests.
if (!process.env.PLATFORM_ADMIN_CLERK_IDS) {
  process.env.PLATFORM_ADMIN_CLERK_IDS = "user_admintest1";
}
// Proxy integration env — fake digest-pinned image and local URLs satisfy
// the startup validation in index.ts (not used here, but deployRunner reads them).
process.env.PROXY_IMAGE = `registry.fly.io/ssc-proxy@sha256:${"a".repeat(64)}`;
const _testPort = process.env.TEST_PORT ?? "4099";
process.env.API_PUBLIC_URL = `http://localhost:${_testPort}`;
process.env.WEB_URL = `http://localhost:${_testPort}`;
process.env.SSC_VERIFY_BASE_URL = `http://localhost:${_testPort}`;
// Keep verification fast in tests (1 s timeout, 100 ms poll)
process.env.SSC_VERIFY_TIMEOUT_MS = "1000";
// Fake Discord webhook — SSC_TEST=1 allows http://localhost; alerts.ts uses this URL.
process.env.ALERT_DISCORD_WEBHOOK_URL = `http://localhost:${_testPort}/test-discord-webhook`;
// Fake Fly Prometheus — flyMetrics.ts honours FLY_METRICS_BASE for loopback hosts.
process.env.FLY_METRICS_BASE = `http://localhost:${_testPort}/fake-prometheus`;
// Fake Clerk API — clerkSync uses this base URL when SSC_TEST=1 and this var is set
process.env.SSC_TEST_CLERK_API_BASE = `http://localhost:${_testPort}/clerk-stub`;

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

  // Yield to the event loop so any pending HTTP requests (e.g. a suspend sent
  // immediately after intake) are processed before we check state.  This makes
  // the AF7 race test reliable without requiring real-deploy mode.
  await new Promise<void>((r) => setTimeout(r, 10));

  // Suspension check — mirrors deployRunner.ts Step 3 to catch the race where
  // an app is suspended after intake accepted but before provisioning starts.
  {
    const { rows: suspRows } = await pool.query<{ suspended_at: Date | null }>(
      "SELECT suspended_at FROM apps WHERE id = $1",
      [appId],
    );
    if (suspRows[0]?.suspended_at !== null) {
      await pool.query(
        `UPDATE deployments SET status='failed', failure_stage='provision',
         failure_message='This app is suspended. Contact the platform admin.',
         finished_at=now() WHERE id=$1`,
        [deploymentId],
      );
      eventBus.emit(deploymentId, {
        type: "error",
        stage: "provision",
        message: "This app is suspended. Contact the platform admin.",
      });
      eventBus.emit(deploymentId, { type: "status", status: "failed" });
      eventBus.emit(deploymentId, { type: "done" });
      return;
    }
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
// AF5: when true, destroyMachine always throws — used to test destroy_error:true
let _destroyMachineFailMode = false;

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
flyModule.destroyMachine = async (appName: string, machineId: string) => {
  _flyCallLog.push({ fn: "destroyMachine", arg: appName, body: { machineId } });
  if (_destroyMachineFailMode) throw new Error("destroyMachine failed (test mode)");
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
const { adminRouter, validateAdminConfig: _validateAdmin } = require("../src/routes/admin") as typeof import("../src/routes/admin");
// Parse PLATFORM_ADMIN_CLERK_IDS now that the env var is set.
// With no-import-time-parsing design, this is the single place that fills _adminIds.
_validateAdmin();

// ── Watchdog stubs ────────────────────────────────────────────────────────────
// Import the watchdog module and validate config (env vars are set above).
// Timers are NOT started — tests trigger rounds via /test/run-probe-round and
// /test/run-metrics-round endpoints.
const watchdogModule = require("../src/lib/watchdog") as typeof import("../src/lib/watchdog");
watchdogModule.validateWatchdogConfig();

// ── Fake app probe endpoints ──────────────────────────────────────────────────
// Per-app probe modes, keyed by fly_app_id.
// Mode "healthy":              health 200 + x-ssc-proxy:1; root 302 + x-ssc-proxy:1 + correct Location
// Mode "exposed-no-sig":       root returns 200 without x-ssc-proxy:1
// Mode "exposed-no-health-sig":health returns 200 without x-ssc-proxy:1
// Mode "exposed-wrong-redirect":health OK; root 302+proxy but Location is /wrong-path
// Mode "unreachable":          both endpoints respond with 503 and no proxy header
//                              (simulates "5xx from Fly edge, no proxy response")
// Default: "healthy"
const _appProbeModes = new Map<string, string>();

// Set base URLs in watchdog module for each probe mode so probes hit this server.
// Called when test sets a probe mode for a fly_app_id.
function _registerProbeBase(flyAppId: string): void {
  watchdogModule._setTestProbeBaseUrl(
    flyAppId,
    `http://localhost:${_testPort}/_probe/${flyAppId}`,
  );
}

// ── Fake Discord webhook ──────────────────────────────────────────────────────
const _discordBodies: Array<{ content: string }> = [];
let _discordFailMode = false;

// ── Fake Fly Prometheus ───────────────────────────────────────────────────────
// Settable per-metric results.  Keys are PromQL query substrings used to route.
// Default: empty result set (no apps in alarm).
interface FakePrometheusResult {
  metric: { app: string };
  value: [number, string];
}
let _promCpuResults: FakePrometheusResult[] = [];
let _promEgressResults: FakePrometheusResult[] = [];
let _promFailMode = false;

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

// POST /test/set-destroy-machine-fail { fail: bool }
// When enabled, the destroyMachine stub throws — used by AF5 to verify destroy_error:true.
app.post("/test/set-destroy-machine-fail", (req, res) => {
  _destroyMachineFailMode = !!(req.body as { fail?: boolean }).fail;
  res.json({ ok: true, destroyMachineFailMode: _destroyMachineFailMode });
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

// ── Fake Clerk API stub ───────────────────────────────────────────────────────
// clerkSync uses SSC_TEST_CLERK_API_BASE (set above) to route Clerk API calls
// here when SSC_TEST=1.  Tests configure per-user responses via /test/set-clerk-user.

interface ClerkUserStub {
  id: string;
  primary_email_address_id: string | null;
  email_addresses: Array<{ id: string; email_address: string; verification: { status: string } }>;
  first_name: string;
  last_name: string;
}

const _clerkUserStubs = new Map<string, ClerkUserStub>();

// GET /clerk-stub/users/:id — fake Clerk GET /v1/users/:id
// Returns 404 for any user not explicitly registered via POST /test/set-clerk-user so that
// missing test setup fails loudly (500 from ensureUser) rather than silently storing "".
app.get("/clerk-stub/users/:id", (req, res) => {
  const stub = _clerkUserStubs.get(req.params.id);
  if (stub) {
    res.json(stub);
  } else {
    res.status(404).json({ error: "not_found", message: `No stub registered for Clerk user ${req.params.id}` });
  }
});

// GET /clerk-stub/organizations/:id — fake Clerk GET /v1/organizations/:id
app.get("/clerk-stub/organizations/:id", (req, res) => {
  res.json({ id: req.params.id, name: req.params.id, slug: req.params.id });
});

// POST /test/set-clerk-user { clerkUserId, email, verified }
// Configures what the fake Clerk endpoint returns for the given clerkUserId.
// verified=true  → primary address is verified; ensureUser stores the email.
// verified=false → primary address is unverified; ensureUser stores "".
// Omit email (or pass "") → no primary address; ensureUser stores "".
app.post("/test/set-clerk-user", (req, res) => {
  const { clerkUserId, email, verified } = req.body as { clerkUserId?: string; email?: string; verified?: boolean };
  if (!clerkUserId) { res.status(400).json({ error: "clerkUserId required" }); return; }
  const e = (email ?? "").trim();
  if (e) {
    _clerkUserStubs.set(clerkUserId, {
      id: clerkUserId,
      primary_email_address_id: "addr_primary",
      email_addresses: [{
        id: "addr_primary",
        email_address: e,
        verification: { status: verified ? "verified" : "unverified" },
      }],
      first_name: "",
      last_name: "",
    });
  } else {
    _clerkUserStubs.set(clerkUserId, {
      id: clerkUserId,
      primary_email_address_id: null,
      email_addresses: [],
      first_name: "",
      last_name: "",
    });
  }
  res.json({ ok: true });
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

// ── Fake app probe routes ─────────────────────────────────────────────────────

// GET /_probe/:flyAppId/__ssc/health
// Modes and health responses:
//   healthy / exposed-no-sig / exposed-wrong-redirect    → 200 + x-ssc-proxy:1
//   exposed-no-health-sig / exposed-health-no-sig-root-5xx → 200, no proxy header
//   unreachable / exposed-root-no-sig-health-5xx          → 503, no proxy header
app.get("/_probe/:flyAppId/__ssc/health", (req, res) => {
  const mode = _appProbeModes.get(req.params.flyAppId) ?? "healthy";
  if (mode === "unreachable" || mode === "exposed-root-no-sig-health-5xx") {
    res.status(503).json({ error: "unavailable" }); return;
  }
  if (mode === "exposed-no-health-sig" || mode === "exposed-health-no-sig-root-5xx") {
    res.status(200).json({ ok: true }); return; // no x-ssc-proxy header
  }
  // healthy / exposed-no-sig / exposed-wrong-redirect — health has the proxy header
  res.set("x-ssc-proxy", "1").status(200).json({ ok: true });
});

// GET /_probe/:flyAppId/
// Modes and root responses:
//   healthy / exposed-no-health-sig                      → 302 + x-ssc-proxy:1 + correct Location
//   exposed-no-sig / exposed-root-no-sig-health-5xx      → 200, no proxy header
//   exposed-wrong-redirect                               → 302 + x-ssc-proxy:1 + wrong Location
//   unreachable / exposed-health-no-sig-root-5xx         → 503, no proxy header
app.get("/_probe/:flyAppId/", (req, res) => {
  const mode = _appProbeModes.get(req.params.flyAppId) ?? "healthy";
  const webUrl = process.env.WEB_URL ?? "";
  const appId  = _probeAppIds.get(req.params.flyAppId) ?? "00000000-0000-0000-0000-000000000000";

  if (mode === "unreachable" || mode === "exposed-health-no-sig-root-5xx") {
    res.status(503).json({ error: "unavailable" }); return;
  }
  if (mode === "exposed-no-sig" || mode === "exposed-root-no-sig-health-5xx") {
    res.status(200).send("<html>hello</html>"); return; // no proxy header
  }
  if (mode === "exposed-wrong-redirect") {
    res.set("x-ssc-proxy", "1")
      .redirect(302, `${webUrl}/wrong-path?app=${appId}`);
    return;
  }
  // healthy / exposed-no-health-sig — correct redirect with real appId
  res.set("x-ssc-proxy", "1").redirect(302, `${webUrl}/access?app=${appId}`);
});

// Map from fly_app_id → app UUID (needed to generate correct redirect Location)
const _probeAppIds = new Map<string, string>();

// ── POST /test/set-app-probe-mode { flyAppId, mode, appId? } ──────────────────
// Controls per-app probe behavior.
// mode: "healthy" | "exposed-no-sig" | "exposed-no-health-sig" | "exposed-wrong-redirect" | "unreachable"
app.post("/test/set-app-probe-mode", (req, res) => {
  const { flyAppId, mode, appId } = req.body as {
    flyAppId?: string; mode?: string; appId?: string;
  };
  if (!flyAppId) { res.status(400).json({ error: "flyAppId required" }); return; }
  const validModes = ["healthy", "exposed-no-sig", "exposed-no-health-sig", "exposed-wrong-redirect", "unreachable", "exposed-health-no-sig-root-5xx", "exposed-root-no-sig-health-5xx"];
  if (mode && !validModes.includes(mode)) {
    res.status(400).json({ error: `invalid mode; valid: ${validModes.join(", ")}` }); return;
  }
  _appProbeModes.set(flyAppId, mode ?? "healthy");
  if (appId) _probeAppIds.set(flyAppId, appId);
  _registerProbeBase(flyAppId);
  res.json({ ok: true, flyAppId, mode: mode ?? "healthy" });
});

// POST /test/clear-probe-state — removes watchdog_probe_state rows and clears local maps
app.post("/test/clear-probe-state", async (_req, res) => {
  _appProbeModes.clear();
  _probeAppIds.clear();
  watchdogModule._clearTestProbeBaseUrls();
  try {
    await pool.query("DELETE FROM watchdog_probe_state");
    await pool.query("DELETE FROM watchdog_alerts");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Fake Discord webhook ──────────────────────────────────────────────────────

app.post("/test-discord-webhook", (req, res) => {
  if (_discordFailMode) {
    res.status(500).json({ error: "discord simulated failure" }); return;
  }
  _discordBodies.push(req.body as { content: string });
  res.status(204).end();
});

// GET /test/drain-discord — returns and clears all recorded Discord bodies
app.get("/test/drain-discord", (_req, res) => {
  res.json({ messages: _discordBodies.splice(0) });
});

// GET /test/get-webhook-url — returns the actual ALERT_DISCORD_WEBHOOK_URL for log-leak assertions
app.get("/test/get-webhook-url", (_req, res) => {
  res.json({ url: process.env.ALERT_DISCORD_WEBHOOK_URL ?? "" });
});

// POST /test/set-discord-fail { fail: bool }
app.post("/test/set-discord-fail", (req, res) => {
  _discordFailMode = !!(req.body as { fail?: boolean }).fail;
  res.json({ ok: true, discordFailMode: _discordFailMode });
});

// ── Fake Fly Prometheus endpoint ──────────────────────────────────────────────
// Served at /fake-prometheus (FLY_METRICS_BASE=http://localhost:<port>/fake-prometheus)
// Full path: GET /fake-prometheus/prometheus/:org/api/v1/query?query=...

app.get("/fake-prometheus/prometheus/:org/api/v1/query", (req, res) => {
  if (_promFailMode) {
    res.status(500).json({ error: "prometheus simulated failure" }); return;
  }
  const query = (req.query.query as string) ?? "";
  let result: FakePrometheusResult[];
  if (query.includes("fly_instance_cpu")) {
    result = _promCpuResults;
  } else if (query.includes("fly_instance_net_sent_bytes")) {
    result = _promEgressResults;
  } else {
    result = [];
  }
  res.json({ status: "success", data: { resultType: "vector", result } });
});

// POST /test/set-prometheus-data { cpu?: [{app, value}], egress?: [{app, value}] }
app.post("/test/set-prometheus-data", (req, res) => {
  const { cpu, egress } = req.body as {
    cpu?: Array<{ app: string; value: number }>;
    egress?: Array<{ app: string; value: number }>;
  };
  if (cpu !== undefined) {
    _promCpuResults = cpu.map((c) => ({
      metric: { app: c.app },
      value: [Math.floor(Date.now() / 1000), String(c.value)] as [number, string],
    }));
  }
  if (egress !== undefined) {
    _promEgressResults = egress.map((c) => ({
      metric: { app: c.app },
      value: [Math.floor(Date.now() / 1000), String(c.value)] as [number, string],
    }));
  }
  res.json({ ok: true });
});

// POST /test/set-prometheus-fail { fail: bool }
app.post("/test/set-prometheus-fail", (req, res) => {
  _promFailMode = !!(req.body as { fail?: boolean }).fail;
  res.json({ ok: true, promFailMode: _promFailMode });
});

// ── Watchdog test-trigger endpoints ──────────────────────────────────────────

// POST /test/run-probe-round — triggers one proxy probe round synchronously
app.post("/test/run-probe-round", async (_req, res) => {
  try {
    await watchdogModule.runProbeRound();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /test/run-metrics-round — triggers one metrics round synchronously
app.post("/test/run-metrics-round", async (_req, res) => {
  try {
    await watchdogModule.runMetricsRound();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
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
app.use("/v1/admin", adminRouter);
app.use((_req, res) => res.status(404).json({ error: "not_found" }));

// Final error middleware — catches anything forwarded via next(err)
app.use(errorHandlerMiddleware);

startReaper();

const PORT = parseInt(process.env.TEST_PORT ?? "4099");
app.listen(PORT, () => {
  process.stdout.write(`[test-server] ready on :${PORT}\n`);
});

export { app };
