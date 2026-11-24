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
// Fake Resend API key — enables email outbox in test mode
process.env.RESEND_API_KEY = "re_test_fake";
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
// Clerk webhook signing secret — fixed 24-byte key, base64-encoded with whsec_ prefix
const _TEST_WEBHOOK_SECRET_BYTES = Buffer.alloc(24).fill(0xab);
export const _TEST_WEBHOOK_SECRET = "whsec_" + _TEST_WEBHOOK_SECRET_BYTES.toString("base64");
process.env.CLERK_WEBHOOK_SIGNING_SECRET = _TEST_WEBHOOK_SECRET;

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

// ── Info/stdout log capture (for ENV value-leak mutation test) ────────────────
const _recentInfoLogs: string[] = [];
const _origConsoleLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  _recentInfoLogs.push(
    args.map((a) => (typeof a === "string" ? a : String(a))).join(" "),
  );
  if (_recentInfoLogs.length > 200) _recentInfoLogs.shift();
  _origConsoleLog(...args);
};

import os from "os";
import path from "path";
import fs from "fs";
import express, { Request, Response, NextFunction } from "express";
import { healthRouter } from "../src/routes/health";
// appsRouter loaded via require() after requireAuth patch (see below)
import { deploymentsRouter } from "../src/routes/deployments";
import { deployStreamRouter } from "../src/routes/deployStream";
import { intakeRouter } from "../src/routes/intake";
// apiKeysRouter loaded via require() after requireAuth patch (see below)
import { authRouter } from "../src/routes/auth";
import { startReaper, reapOrphanedFlyApps, reapExpiredProxyCodes, reapKeysByMembership, reapOldBuildLogs } from "../src/lib/reaper";
import { runReconcile, ClerkOrgCheck } from "../src/lib/reconcile";
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

  // Record whether the app already had a fly_app_id (for failure cleanup below)
  const { rows: _appBefore } = await pool.query<{ fly_app_id: string | null }>(
    "SELECT fly_app_id FROM apps WHERE id=$1",
    [appId],
  );
  const hadFlyAppId = !!_appBefore[0]?.fly_app_id;

  // Set fly_app_id on the app so subdomain works
  await pool.query("UPDATE apps SET fly_app_id=$1 WHERE id=$2", [flyAppName, appId]);

  // Short delay to simulate async work
  await new Promise((r) => setTimeout(r, 80));

  if (mode === "failure") {
    // Clear fly_app_id for new apps (mirrors real deployRunner fail() behaviour)
    if (!hadFlyAppId) {
      await pool.query("UPDATE apps SET fly_app_id=NULL WHERE id=$1", [appId]);
    }
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
const flyAuthHeader = (flyModule as typeof import("../src/services/flyClient")).flyAuthHeader;

interface FlyCall { fn: string; arg: string; body?: Record<string, unknown> }
const _flyCallLog: FlyCall[] = [];

let _checkExistsResult = true;
// Per-app missing set: fly_app_ids that checkFlyAppExists should return false for.
const _missingFlyAppIds = new Set<string>();
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
  if (_missingFlyAppIds.has(name)) return false;
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
// ── Fly secret stubs ──────────────────────────────────────────────────────────
let _setFlySecretFailMode = false;
let _unsetFlySecretFailMode = false;
let _updateFlyMachineFailMode = false;

flyModule.setFlySecret = async (appName: string, name: string) => {
  _flyCallLog.push({ fn: "setFlySecret", arg: appName, body: { name } });
  if (_setFlySecretFailMode) throw new Error("setFlySecret failed (test mode)");
};
flyModule.unsetFlySecret = async (appName: string, name: string) => {
  _flyCallLog.push({ fn: "unsetFlySecret", arg: appName, body: { name } });
  if (_unsetFlySecretFailMode) throw new Error("unsetFlySecret failed (test mode)");
};
flyModule.getMachine = async (appName: string, machineId: string) => {
  _flyCallLog.push({ fn: "getMachine", arg: appName, body: { machineId } });
  // Return a minimal machine config (the real code passes this straight to updateFlyMachine)
  return { id: machineId, config: { image: "placeholder" } };
};
flyModule.updateFlyMachine = async (appName: string, machineId: string) => {
  _flyCallLog.push({ fn: "updateFlyMachine", arg: appName, body: { machineId } });
  if (_updateFlyMachineFailMode) throw new Error("updateFlyMachine failed (test mode)");
};
// updateFlyMachines is stubbed to avoid real HTTP calls while still recording
// each machine UPDATE call so ENV-24 can assert updateFlyMachine was invoked.
flyModule.updateFlyMachines = async (appName: string) => {
  _flyCallLog.push({ fn: "updateFlyMachines", arg: appName });
  if (_updateFlyMachineFailMode) throw new Error("updateFlyMachine failed (test mode)");
  for (const m of _listMachinesResult) {
    // Record individual machine UPDATE calls so tests can verify the pattern.
    _flyCallLog.push({ fn: "getMachine", arg: appName, body: { machineId: m.id } });
    _flyCallLog.push({ fn: "updateFlyMachine", arg: appName, body: { machineId: m.id } });
  }
  return { updated: _listMachinesResult.length };
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
      const revAgeH = req.headers["x-test-clerk-reverification-age"];
      const clerkOrgId = Array.isArray(orgIdH) ? orgIdH[0] : (orgIdH as string | undefined);
      const clerkOrgRole = Array.isArray(orgRoleH) ? orgRoleH[0] : (orgRoleH as string | undefined);
      const revAgeStr = Array.isArray(revAgeH) ? revAgeH[0] : (revAgeH as string | undefined);
      const fva: [number, number] | undefined = revAgeStr !== undefined ? [parseInt(revAgeStr, 10), -1] : undefined;
      req.sscAuth = {
        type: "clerk",
        clerkUserId,
        ...(clerkOrgId ? { clerkOrgId } : {}),
        ...(clerkOrgRole ? { clerkOrgRole } : {}),
        ...(fva !== undefined ? { factorVerificationAge: fva } : {}),
      };
      next();
      return;
    }
    _origRA(req, res, next);
  };
}

// Load routers that depend on requireAuth AFTER the patch above.
// Must use require() here — import statements are hoisted before this body runs.
const { appsRouter } = require("../src/routes/apps") as typeof import("../src/routes/apps");
const { proxyRouter } = require("../src/routes/proxy") as typeof import("../src/routes/proxy");
const { appAccessRouter } = require("../src/routes/appAccess") as typeof import("../src/routes/appAccess");
const { appEnvRouter } = require("../src/routes/appEnv") as typeof import("../src/routes/appEnv");
const { apiKeysRouter } = require("../src/routes/apiKeys") as typeof import("../src/routes/apiKeys");
const { webhookRouter } = require("../src/routes/webhooks") as typeof import("../src/routes/webhooks");
const { verifyClerkWebhookSignature } = require("../src/routes/webhooks") as typeof import("../src/routes/webhooks");
const { adminRouter, validateAdminConfig: _validateAdmin } = require("../src/routes/admin") as typeof import("../src/routes/admin");
const { activityAdminRouter, adminStatsRouter } = require("../src/routes/activityAdmin") as typeof import("../src/routes/activityAdmin");
const { meRouter } = require("../src/routes/me") as typeof import("../src/routes/me");
const { workspaceRouter } = require("../src/routes/workspace") as typeof import("../src/routes/workspace");
const { _resetThrottleMapsForTest, _armInsertFailureForTest, _resetActivitySearchedThrottleForTest } = require("../src/lib/activityLog") as typeof import("../src/lib/activityLog");
const { MemorySender, setEmailSender, disableEmailSender } = require("../src/lib/email/sender") as typeof import("../src/lib/email/sender");
const { runEmailOutboxSender } = require("../src/lib/email/outbox") as typeof import("../src/lib/email/outbox");

// ── Email sender stub ─────────────────────────────────────────────────────────
// Use MemorySender so tests can drain sent emails; no real HTTP calls to Resend.
const _memorySender = new MemorySender();
setEmailSender(_memorySender);
const { issueProxyToken } = require("../src/lib/proxyCredentials") as typeof import("../src/lib/proxyCredentials");
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

// webhook router MUST be mounted before express.json() to capture raw body
app.use("/v1/webhooks", webhookRouter);

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

// POST /test/set-flyctl-output { exitCode, outputLines }
// Rewrites the fake flyctl binary to print each line in outputLines then exit
// with the given code.  Used by AJ2 to test extractBuildFailureLine in the real
// deploy path.  Lines are written to a temp file to avoid shell escaping issues.
app.post("/test/set-flyctl-output", (req, res) => {
  const { exitCode, outputLines } = req.body as { exitCode?: number; outputLines?: string[] };
  const code = typeof exitCode === "number" ? exitCode : 1;
  const lines = Array.isArray(outputLines) ? outputLines : [];
  const outputFile = path.join(_fakeFlyctlDir, "flyctl-output.txt");
  fs.writeFileSync(outputFile, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
  writeFlyctlScript(code, `cat ${outputFile}`);
  res.json({ ok: true });
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

// POST /test/reset-activity-throttle — clears in-memory flood throttle maps
// Used by AR-M1 test to ensure a clean slate before the flood test.
app.post("/test/reset-activity-throttle", (_req, res) => {
  _resetThrottleMapsForTest();
  _resetActivitySearchedThrottleForTest();
  res.json({ ok: true });
});

// POST /test/set-user-email — sets a user's email by clerk_user_id (for A4 email tests)
app.post("/test/set-user-email", (async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clerk_user_id, email } = req.body as { clerk_user_id: string; email: string };
    await pool.query("UPDATE users SET email = $1 WHERE clerk_user_id = $2", [email, clerk_user_id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}) as express.RequestHandler);

// POST /test/arm-activity-insert-failure — causes next recordActivityInTx call to throw
app.post("/test/arm-activity-insert-failure", (_req, res) => {
  _armInsertFailureForTest();
  res.json({ ok: true });
});

// POST /test/set-proxy-token { appId } — issues a proxy token for the given app
// and returns it plaintext. Used by AR-M8 to set up proxy code exchange tests.
app.post("/test/set-proxy-token", async (req, res) => {
  const { appId } = req.body as { appId?: string };
  if (!appId) { res.status(400).json({ error: "appId required" }); return; }
  try {
    const token = await issueProxyToken(appId);
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
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

// POST /test/set-fly-app-missing { flyAppId, missing: bool }
// Makes checkFlyAppExists return false for a specific fly_app_id.
app.post("/test/set-fly-app-missing", (req, res) => {
  const { flyAppId, missing } = req.body as { flyAppId?: string; missing?: boolean };
  if (!flyAppId) { res.status(400).json({ error: "flyAppId required" }); return; }
  if (missing) {
    _missingFlyAppIds.add(flyAppId);
  } else {
    _missingFlyAppIds.delete(flyAppId);
  }
  res.json({ ok: true, flyAppId, missing: missing ?? false });
});

// POST /test/set-fly-token { token: string }
// Changes FLY_API_TOKEN in this process (affects both flyClient and flyMetrics auth).
// Tests MUST restore to "test-token" after use.
app.post("/test/set-fly-token", (req, res) => {
  const { token } = req.body as { token?: string };
  if (typeof token !== "string") { res.status(400).json({ error: "token required" }); return; }
  process.env.FLY_API_TOKEN = token;
  res.json({ ok: true });
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

// POST /test/gen-fly-toml { appName, appId, kind?, appPort?, packageJson? }
// Calls generateDeployFiles in-process and returns generated fly.toml (and nginx conf
// for static, Dockerfile and nodeVersionLog for node).
// kind: "node"|"python"|"static"|"dockerfile" (default "node").
// appPort is passed through for the "dockerfile" kind to test port pass-through.
// packageJson: written as package.json to the tmpDir before calling generateDeployFiles.
app.post("/test/gen-fly-toml", async (req, res) => {
  const { appName, appId, kind, appPort, packageJson, appSecretNames } = req.body as {
    appName?: string; appId?: string; kind?: string; appPort?: number; packageJson?: unknown; appSecretNames?: string[];
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
    if (packageJson !== undefined) {
      fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify(packageJson), "utf8");
    }

    const { nodeVersionLog } = await generateDeployFiles(tmpDir, appName, appType, appId, typeof appPort === "number" ? appPort : undefined, appSecretNames ?? []);

    const flyToml = fs.readFileSync(path.join(tmpDir, "fly.toml"), "utf8");
    const nginxConf = kind === "static" && fs.existsSync(path.join(tmpDir, "ssc-nginx.conf"))
      ? fs.readFileSync(path.join(tmpDir, "ssc-nginx.conf"), "utf8")
      : undefined;
    const dockerfile = (!kind || kind === "node" || kind === "python" || kind === "static")
      && fs.existsSync(path.join(tmpDir, "Dockerfile"))
      ? fs.readFileSync(path.join(tmpDir, "Dockerfile"), "utf8")
      : undefined;
    res.json({
      flyToml,
      ...(nginxConf ? { nginxConf } : {}),
      ...(dockerfile ? { dockerfile } : {}),
      ...(nodeVersionLog ? { nodeVersionLog } : {}),
    });
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

// POST /test/run-reconcile
// Runs runReconcile() with an injected clerkCheck so tests don't need a live Clerk API.
//
// Body:
//   apply:       boolean  — whether to actually delete orphaned orgs
//   max?:        number   — max orgs to clean (default 3)
//   only?:       string[] — restrict to these internal org UUIDs
//   yes?:        boolean  — skip confirmation (always true in tests)
//   mockChecks?: Record<clerkOrgId, ClerkOrgCheck>
//     Each entry overrides the default HTTP check for that clerkOrgId.
//     Use { found: false, httpStatus: 404 } to simulate orphaned.
//     Use { error: true, httpStatus: 401, message: "..." } to simulate errors.
//     Use { error: true, httpStatus: 0, message: "timeout" } for network/timeout.
//     Orgs not in mockChecks get { found: true, httpStatus: 200 } by default.
app.post("/test/run-reconcile", async (req, res) => {
  const { apply, max, only, mockChecks } = req.body as {
    apply?: boolean;
    max?: number;
    only?: string[];
    mockChecks?: Record<string, ClerkOrgCheck>;
  };

  const clerkCheck = async (clerkOrgId: string): Promise<ClerkOrgCheck> => {
    if (mockChecks && Object.prototype.hasOwnProperty.call(mockChecks, clerkOrgId)) {
      return mockChecks[clerkOrgId];
    }
    // Default: org exists in Clerk
    return { found: true, httpStatus: 200 };
  };

  try {
    const result = await runReconcile(
      { apply: apply ?? false, max, only, yes: true },
      clerkCheck,
    );
    res.json(result);
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

// GET /test/drain-info-logs
// Returns and clears the captured console.log lines (for ENV value-leak mutation test).
app.get("/test/drain-info-logs", (_req, res) => {
  res.json({ logs: _recentInfoLogs.splice(0) });
});

// POST /test/set-fly-secret-fail { fail: bool }
app.post("/test/set-fly-secret-fail", (req, res) => {
  _setFlySecretFailMode = !!(req.body as { fail?: boolean }).fail;
  res.json({ ok: true });
});

// POST /test/set-unset-fly-secret-fail { fail: bool }
app.post("/test/set-unset-fly-secret-fail", (req, res) => {
  _unsetFlySecretFailMode = !!(req.body as { fail?: boolean }).fail;
  res.json({ ok: true });
});

// POST /test/set-update-fly-machine-fail { fail: bool }
app.post("/test/set-update-fly-machine-fail", (req, res) => {
  _updateFlyMachineFailMode = !!(req.body as { fail?: boolean }).fail;
  res.json({ ok: true });
});

// POST /test/set-clerk-membership { clerkOrgId, clerkUserId, isMember }
// Controls what the fake /clerk-stub/organizations/:orgId/memberships endpoint returns.
app.post("/test/set-clerk-membership", (req, res) => {
  const { clerkOrgId, clerkUserId, isMember } = req.body as {
    clerkOrgId?: string; clerkUserId?: string; isMember?: boolean;
  };
  if (!clerkOrgId || !clerkUserId) {
    res.status(400).json({ error: "clerkOrgId and clerkUserId required" }); return;
  }
  const key = `${clerkOrgId}:${clerkUserId}`;
  _clerkMembershipStubs.set(key, isMember !== false);
  res.json({ ok: true, key, isMember: isMember !== false });
});

// POST /test/set-clerk-membership-fail { fail: bool }
// When enabled, the membership endpoint returns 500 (simulates Clerk API error).
app.post("/test/set-clerk-membership-fail", (req, res) => {
  _clerkMembershipFailMode = !!(req.body as { fail?: boolean }).fail;
  res.json({ ok: true, clerkMembershipFailMode: _clerkMembershipFailMode });
});

// ── User org memberships stub (for getUserOrgIds in clerkSync) ────────────────
// GET /clerk-stub/users/:userId/organization_memberships?limit=N&offset=M
// Returns a paginated slice of the orgs registered via POST /test/set-user-org-memberships.
// Default: empty list (user is not a member of any org).
// Fail mode: POST /test/set-user-org-memberships-fail { fail: bool } → 500.

const _userOrgMemberships = new Map<string, string[]>(); // clerkUserId → clerkOrgId[]
let _userOrgMembershipsFailMode = false;
// Per-user call counter — incremented on each GET (even failed ones)
const _userOrgMembershipsCallCount = new Map<string, number>();

app.get("/clerk-stub/users/:userId/organization_memberships", (req, res) => {
  _userOrgMembershipsCallCount.set(
    req.params.userId,
    (_userOrgMembershipsCallCount.get(req.params.userId) ?? 0) + 1,
  );
  if (_userOrgMembershipsFailMode) {
    res.status(500).json({ error: "simulated clerk api error" }); return;
  }
  const orgIds = _userOrgMemberships.get(req.params.userId) ?? [];
  // Honour limit/offset for pagination tests
  const limit = parseInt((req.query.limit as string) ?? "100", 10);
  const offset = parseInt((req.query.offset as string) ?? "0", 10);
  const page = orgIds.slice(offset, offset + limit);
  const data = page.map((id) => ({ organization: { id } }));
  res.json({ data, total_count: orgIds.length });
});

// POST /test/set-user-org-memberships { clerkUserId, orgIds: string[] }
// Configures which Clerk org IDs the stub reports for a given user.
app.post("/test/set-user-org-memberships", (req, res) => {
  const { clerkUserId, orgIds } = req.body as { clerkUserId?: string; orgIds?: string[] };
  if (!clerkUserId || !Array.isArray(orgIds)) {
    res.status(400).json({ error: "clerkUserId and orgIds[] required" }); return;
  }
  _userOrgMemberships.set(clerkUserId, orgIds);
  res.json({ ok: true, clerkUserId, orgIds });
});

// POST /test/set-user-org-memberships-fail { fail: bool }
app.post("/test/set-user-org-memberships-fail", (req, res) => {
  _userOrgMembershipsFailMode = !!(req.body as { fail?: boolean }).fail;
  res.json({ ok: true, userOrgMembershipsFailMode: _userOrgMembershipsFailMode });
});

// GET /test/get-user-memberships-call-count?clerkUserId=X
// Returns how many times the memberships stub was called for a given user.
app.get("/test/get-user-memberships-call-count", (req, res) => {
  const userId = (req.query.clerkUserId as string) ?? "";
  res.json({ count: _userOrgMembershipsCallCount.get(userId) ?? 0 });
});

// POST /test/reset-user-memberships-call-count { clerkUserId? }
// Resets the counter for one user (or all users if clerkUserId is omitted).
app.post("/test/reset-user-memberships-call-count", (req, res) => {
  const { clerkUserId } = req.body as { clerkUserId?: string };
  if (clerkUserId) {
    _userOrgMembershipsCallCount.delete(clerkUserId);
  } else {
    _userOrgMembershipsCallCount.clear();
  }
  res.json({ ok: true });
});

// Cache / fetch-limit control (for getUserOrgIds 60s cache and pagination tests)
const { _clearOrgIdsCacheForTest, _setOrgIdsFetchLimitForTest } =
  require("../src/lib/clerkSync") as typeof import("../src/lib/clerkSync");

// POST /test/clear-org-ids-cache — clears the per-user 60s cache
app.post("/test/clear-org-ids-cache", (_req, res) => {
  _clearOrgIdsCacheForTest();
  res.json({ ok: true });
});

// POST /test/set-org-ids-fetch-limit { limit: number }
// Sets the per-page limit used in getUserOrgIds (default 100). Lower it in tests
// to simulate pagination without needing > 100 orgs.
app.post("/test/set-org-ids-fetch-limit", (req, res) => {
  const { limit } = req.body as { limit?: number };
  if (typeof limit !== "number" || limit < 1) {
    res.status(400).json({ error: "limit must be a positive number" }); return;
  }
  _setOrgIdsFetchLimitForTest(limit);
  res.json({ ok: true, limit });
});

// POST /test/sign-webhook-event { body, timestamp?, id? }
// Computes svix HMAC-SHA256 signature using the test webhook secret.
// Returns svixId, svixTimestamp, svixSignature ready to pass as headers.
app.post("/test/sign-webhook-event", (req, res) => {
  const { body, timestamp, id } = req.body as {
    body?: unknown; timestamp?: string; id?: string;
  };
  if (body === undefined) { res.status(400).json({ error: "body required" }); return; }
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  const svixId = id ?? `msg_${Date.now()}`;
  const svixTimestamp = timestamp ?? String(Math.floor(Date.now() / 1000));
  const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET ?? _TEST_WEBHOOK_SECRET;

  // Compute signature: HMAC-SHA256(base64decode(secret after "whsec_"), "<id>.<ts>.<body>")
  const { createHmac } = require("crypto") as typeof import("crypto");
  const secretBytes = Buffer.from(secret.slice("whsec_".length), "base64");
  const signedPayload = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sig = createHmac("sha256", secretBytes).update(signedPayload).digest("base64");

  res.json({ svixId, svixTimestamp, svixSignature: `v1,${sig}` });
});

// POST /test/set-webhook-secret { secret: string | null }
// Overrides CLERK_WEBHOOK_SIGNING_SECRET for AI6 startup-check tests.
// Pass null to unset.
app.post("/test/set-webhook-secret", (req, res) => {
  const { secret } = req.body as { secret?: string | null };
  if (secret === null || secret === undefined) {
    delete process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  } else {
    process.env.CLERK_WEBHOOK_SIGNING_SECRET = secret;
  }
  res.json({ ok: true });
});

// POST /test/run-key-reconciliation — triggers one membership reconciliation pass
app.post("/test/run-key-reconciliation", async (_req, res) => {
  try {
    const revoked = await reapKeysByMembership();
    res.json({ ok: true, revoked });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /test/run-email-outbox — runs one email outbox pass synchronously
app.post("/test/run-email-outbox", async (_req, res) => {
  try {
    const sent = await runEmailOutboxSender();
    res.json({ ok: true, sent });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /test/set-build-log { deployment_id, content, truncated? }
// Inserts (or replaces) a build log row directly — used by BL tests to seed
// log content, including content with fake secrets to test scrubbing at read time.
app.post("/test/set-build-log", async (req, res) => {
  const { deployment_id, content, truncated = false } = req.body as {
    deployment_id: string;
    content: string;
    truncated?: boolean;
  };
  try {
    await pool.query(
      `INSERT INTO deployment_build_logs (deployment_id, content, truncated)
       VALUES ($1, $2, $3)
       ON CONFLICT (deployment_id) DO UPDATE
         SET content = EXCLUDED.content, truncated = EXCLUDED.truncated`,
      [deployment_id, content, truncated],
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /test/run-reap-build-logs — runs one build-log reaper pass synchronously
app.post("/test/run-reap-build-logs", async (_req, res) => {
  try {
    const deleted = await reapOldBuildLogs();
    res.json({ ok: true, deleted });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /test/get-sent-emails — returns and clears all emails captured by MemorySender
app.get("/test/get-sent-emails", (_req, res) => {
  res.json({ emails: _memorySender.drain() });
});

// POST /test/set-email-disabled { disabled: bool }
// Disables or re-enables the email sender. When disabled, email_status:"disabled".
app.post("/test/set-email-disabled", (req, res) => {
  const { disabled } = req.body as { disabled?: boolean };
  if (disabled) {
    disableEmailSender();
  } else {
    setEmailSender(_memorySender);
  }
  res.json({ ok: true, disabled: disabled ?? false });
});

// POST /test/set-memory-sender-fail { times: number }
// 0 = succeed; -1 = always fail; N = fail next N calls then succeed.
app.post("/test/set-memory-sender-fail", (req, res) => {
  const { times } = req.body as { times?: number };
  _memorySender.setFailMode(typeof times === "number" ? times : 0);
  res.json({ ok: true, times });
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

// Membership stubs: key = "${orgId}:${userId}", value = true (member) | false (not a member)
// Absent = not configured — returns 200 total_count=0 by default (safe: triggers "left" check)
const _clerkMembershipStubs = new Map<string, boolean>();
let _clerkMembershipFailMode = false;

// GET /clerk-stub/users/:id — fake Clerk GET /v1/users/:id
// Returns 404 (with Clerk's resource_not_found body) for any user not explicitly
// registered via POST /test/set-clerk-user so that missing test setup fails loudly
// (500 from ensureUser) rather than silently storing "".
// The resource_not_found body matches Clerk's actual 404 format so checkOrgMembership
// correctly treats the user as deleted (vs. treating it as an API error).
app.get("/clerk-stub/users/:id", (req, res) => {
  const stub = _clerkUserStubs.get(req.params.id);
  if (stub) {
    res.json(stub);
  } else {
    res.status(404).json({
      errors: [{ code: "resource_not_found", message: `No stub registered for Clerk user ${req.params.id}` }],
    });
  }
});

// GET /clerk-stub/organizations/:id — fake Clerk GET /v1/organizations/:id
// Well-known test orgs return deterministic human-readable names so ensureOrg()
// doesn't overwrite the seeded "Org Alpha" / "Org Beta" names with the clerk_org_* ID.
// Additional entries can be registered at runtime via POST /test/set-clerk-org-name.
//
// Per-org error overrides (registered via POST /test/set-clerk-org-error) let tests
// simulate 401/403/429/500 and 404-without-resource_not_found responses.
const _knownOrgNames: Map<string, { name: string; slug: string }> = new Map([
  ["clerk_org_aaa", { name: "Org Alpha", slug: "org-alpha" }],
  ["clerk_org_bbb", { name: "Org Beta",  slug: "org-beta"  }],
]);

interface ClerkOrgError {
  httpStatus: number;  // e.g. 401, 429, 500; 404 → 404 WITHOUT resource_not_found
  message?: string;
}
// Per-org error overrides: httpStatus → error response (not a confirmed deletion).
// 404 overrides intentionally omit resource_not_found so callers treat it as an error.
const _clerkOrgErrors: Map<string, ClerkOrgError> = new Map();

// Orgs marked as "deleted in Clerk" (returns 404 + resource_not_found on GET).
// Set via POST /test/set-clerk-org-deleted { clerkOrgId }.
const _clerkOrgsDeletedInClerk: Set<string> = new Set();

app.get("/clerk-stub/organizations/:id", (req, res) => {
  const orgId = req.params.id;

  // Per-org error override (401, 429, 500, or 404-without-resource_not_found)
  const errorOverride = _clerkOrgErrors.get(orgId);
  if (errorOverride) {
    if (errorOverride.httpStatus === 404) {
      // 404 without resource_not_found — caller treats as error, not orphaned
      res.status(404).json({ errors: [{ code: "some_other_error", message: errorOverride.message ?? "not found" }] });
    } else {
      res.status(errorOverride.httpStatus).json({ errors: [{ code: "api_error", message: errorOverride.message ?? "error" }] });
    }
    return;
  }

  // Orgs explicitly marked deleted in Clerk → 404 + resource_not_found → orphaned
  if (_clerkOrgsDeletedInClerk.has(orgId)) {
    res.status(404).json({ errors: [{ code: "resource_not_found", message: "Organization not found" }] });
    return;
  }

  const known = _knownOrgNames.get(orgId);
  res.json({ id: orgId, name: known?.name ?? orgId, slug: known?.slug ?? orgId });
});

// POST /test/set-clerk-org-error { clerkOrgId, httpStatus, message? }
// Makes GET /clerk-stub/organizations/:id return a non-200 error response.
// httpStatus=404 returns a 404 WITHOUT resource_not_found (treated as error, not orphaned).
// Pass httpStatus=0 to remove the override (back to 200).
app.post("/test/set-clerk-org-error", (req, res) => {
  const { clerkOrgId, httpStatus, message } = req.body as { clerkOrgId?: string; httpStatus?: number; message?: string };
  if (!clerkOrgId || httpStatus === undefined) {
    res.status(400).json({ error: "clerkOrgId and httpStatus required" }); return;
  }
  if (httpStatus === 0) {
    _clerkOrgErrors.delete(clerkOrgId);
  } else {
    _clerkOrgErrors.set(clerkOrgId, { httpStatus, message });
  }
  res.json({ ok: true });
});

// POST /test/set-clerk-org-deleted { clerkOrgId, deleted: bool }
// Marks an org as deleted in Clerk (GET returns 404 + resource_not_found → orphaned).
// Pass deleted: false to restore 200 behavior.
app.post("/test/set-clerk-org-deleted", (req, res) => {
  const { clerkOrgId, deleted } = req.body as { clerkOrgId?: string; deleted?: boolean };
  if (!clerkOrgId) { res.status(400).json({ error: "clerkOrgId required" }); return; }
  if (deleted === false) {
    _clerkOrgsDeletedInClerk.delete(clerkOrgId);
  } else {
    _clerkOrgsDeletedInClerk.add(clerkOrgId);
  }
  res.json({ ok: true });
});

// POST /test/set-clerk-org-name { clerkOrgId, name, slug? }
// Registers (or overwrites) the display name the org stub returns for a given clerkOrgId.
// Required so workspace-delete tests can distinguish the display name from the org slug.
app.post("/test/set-clerk-org-name", (req, res) => {
  const { clerkOrgId, name, slug } = req.body as { clerkOrgId?: string; name?: string; slug?: string };
  if (!clerkOrgId || !name) {
    res.status(400).json({ error: "clerkOrgId and name required" }); return;
  }
  _knownOrgNames.set(clerkOrgId, { name, slug: slug ?? clerkOrgId });
  res.json({ ok: true, clerkOrgId, name });
});

// DELETE /clerk-stub/users/:id — fake Clerk DELETE /v1/users/:id
// Succeeds by default. Configured to fail via POST /test/set-clerk-delete-user-fail.
let _clerkDeleteUserFailMode = false;
const _clerkDeletedUsers: Set<string> = new Set();
app.delete("/clerk-stub/users/:id", (req, res) => {
  if (_clerkDeleteUserFailMode) {
    res.status(500).json({ error: "simulated clerk delete user error" }); return;
  }
  _clerkDeletedUsers.add(req.params.id);
  res.status(200).json({ deleted: true });
});

app.post("/test/set-clerk-delete-user-fail", (req, res) => {
  _clerkDeleteUserFailMode = !!(req.body as { fail?: boolean }).fail;
  res.json({ ok: true, clerkDeleteUserFailMode: _clerkDeleteUserFailMode });
});

app.get("/test/get-clerk-deleted-users", (_req, res) => {
  res.json({ users: Array.from(_clerkDeletedUsers) });
  _clerkDeletedUsers.clear();
});

// DELETE /clerk-stub/organizations/:id — fake Clerk DELETE /v1/organizations/:id
// Succeeds by default. Configured to fail via POST /test/set-clerk-delete-org-fail.
let _clerkDeleteOrgFailMode = false;
const _clerkDeletedOrgs: Set<string> = new Set();
app.delete("/clerk-stub/organizations/:id", (req, res) => {
  if (_clerkDeleteOrgFailMode) {
    res.status(500).json({ error: "simulated clerk delete org error" }); return;
  }
  _clerkDeletedOrgs.add(req.params.id);
  res.status(200).json({ deleted: true });
});

// POST /test/set-clerk-delete-org-fail { fail: bool }
app.post("/test/set-clerk-delete-org-fail", (req, res) => {
  _clerkDeleteOrgFailMode = !!(req.body as { fail?: boolean }).fail;
  res.json({ ok: true, clerkDeleteOrgFailMode: _clerkDeleteOrgFailMode });
});

// GET /test/get-clerk-deleted-orgs — returns orgs deleted via DELETE stub
app.get("/test/get-clerk-deleted-orgs", (_req, res) => {
  res.json({ orgs: Array.from(_clerkDeletedOrgs) });
  _clerkDeletedOrgs.clear();
});

// GET /clerk-stub/organizations/:orgId/memberships?user_id=:userId  (reconcile path)
// GET /clerk-stub/organizations/:orgId/memberships?limit=N&offset=N (list-all path)
// 500 when _clerkMembershipFailMode is true (simulates API error).
//
// Full member list is stored in _clerkOrgMembersMap and controlled via
// POST /test/set-clerk-org-members.  When user_id is supplied, falls back to
// _clerkMembershipStubs for backward-compat with existing reconcile tests.
interface ClerkMemberStub {
  userId: string;
  role: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  joinedAt: string;
}
const _clerkOrgMembersMap = new Map<string, ClerkMemberStub[]>(); // orgId → members

app.get("/clerk-stub/organizations/:orgId/memberships", (req, res) => {
  if (_clerkMembershipFailMode) {
    res.status(500).json({ error: "simulated clerk api error" }); return;
  }
  const { orgId } = req.params;
  const userId = (req.query.user_id as string) ?? "";

  if (userId) {
    // Legacy reconcile path: single-user membership check
    const key = `${orgId}:${userId}`;
    const isMember = _clerkMembershipStubs.get(key) ?? false;
    res.json({ total_count: isMember ? 1 : 0, data: [] });
    return;
  }

  // Full member list path
  const members = _clerkOrgMembersMap.get(orgId) ?? [];
  const limit = parseInt((req.query.limit as string) ?? "100", 10);
  const offset = parseInt((req.query.offset as string) ?? "0", 10);
  const page = members.slice(offset, offset + limit);
  const data = page.map((m) => ({
    role: m.role,
    created_at: new Date(m.joinedAt).getTime(),
    public_user_data: {
      user_id: m.userId,
      identifier: m.email,
      first_name: m.firstName,
      last_name: m.lastName,
    },
  }));
  res.json({ data, total_count: members.length });
});

// POST /test/set-clerk-org-members { clerkOrgId, members: ClerkMemberStub[] }
// Configures the full member list for a given org.
app.post("/test/set-clerk-org-members", (req, res) => {
  const { clerkOrgId, members } = req.body as { clerkOrgId?: string; members?: ClerkMemberStub[] };
  if (!clerkOrgId || !Array.isArray(members)) {
    res.status(400).json({ error: "clerkOrgId and members[] required" }); return;
  }
  _clerkOrgMembersMap.set(clerkOrgId, members);
  res.json({ ok: true, clerkOrgId, count: members.length });
});

// ── Clerk org invitations stubs ───────────────────────────────────────────────

interface ClerkInvitationStub {
  id: string;
  emailAddress: string;
  role: string;
  createdAt: string;
  redirectUrl: string;
}
const _clerkOrgInvitationsMap = new Map<string, ClerkInvitationStub[]>(); // orgId → invitations
let _clerkInvitationFailMode = false;
let _lastCreatedInvitation: ClerkInvitationStub | null = null;

// GET /clerk-stub/organizations/:orgId/invitations?status=pending&limit=N&offset=N
app.get("/clerk-stub/organizations/:orgId/invitations", (req, res) => {
  if (_clerkInvitationFailMode) {
    res.status(500).json({ error: "simulated clerk api error" }); return;
  }
  const { orgId } = req.params;
  const invitations = _clerkOrgInvitationsMap.get(orgId) ?? [];
  const limit = parseInt((req.query.limit as string) ?? "100", 10);
  const offset = parseInt((req.query.offset as string) ?? "0", 10);
  const page = invitations.slice(offset, offset + limit);
  const data = page.map((i) => ({
    id: i.id,
    email_address: i.emailAddress,
    role: i.role,
    created_at: new Date(i.createdAt).getTime(),
  }));
  res.json({ data, total_count: invitations.length });
});

// POST /clerk-stub/organizations/:orgId/invitations — create invitation
app.post("/clerk-stub/organizations/:orgId/invitations", (req, res) => {
  if (_clerkInvitationFailMode) {
    res.status(500).json({ error: "simulated clerk api error" }); return;
  }
  const { orgId } = req.params;
  const { email_address, role, redirect_url } = req.body as { email_address?: string; role?: string; redirect_url?: string };
  if (!email_address) { res.status(422).json({ errors: [{ code: "missing_email" }] }); return; }

  // Check if already a member
  const members = _clerkOrgMembersMap.get(orgId) ?? [];
  if (members.some((m) => m.email.toLowerCase() === (email_address ?? "").toLowerCase())) {
    res.status(422).json({ errors: [{ code: "already_a_member" }] }); return;
  }

  const inv: ClerkInvitationStub = {
    id: `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    emailAddress: email_address,
    role: role ?? "org:member",
    createdAt: new Date().toISOString(),
    redirectUrl: redirect_url ?? "",
  };
  const existing = _clerkOrgInvitationsMap.get(orgId) ?? [];
  _clerkOrgInvitationsMap.set(orgId, [...existing, inv]);
  _lastCreatedInvitation = inv;
  res.status(200).json({ id: inv.id, email_address: inv.emailAddress, role: inv.role });
});

// POST /clerk-stub/organizations/:orgId/invitations/:id/revoke
let _lastRevokeRequestingUserId: string | null = null;
app.post("/clerk-stub/organizations/:orgId/invitations/:id/revoke", (req, res) => {
  if (_clerkInvitationFailMode) {
    res.status(500).json({ error: "simulated clerk api error" }); return;
  }
  const { orgId, id } = req.params;
  _lastRevokeRequestingUserId = (req.body as { requesting_user_id?: string }).requesting_user_id ?? null;
  const existing = _clerkOrgInvitationsMap.get(orgId) ?? [];
  const idx = existing.findIndex((i) => i.id === id);
  if (idx === -1) { res.status(404).json({ errors: [{ code: "resource_not_found" }] }); return; }
  _clerkOrgInvitationsMap.set(orgId, existing.filter((_, i) => i !== idx));
  res.json({ revoked: true });
});

// GET /test/get-last-revoke — returns { requestingUserId } from most recent revoke call
app.get("/test/get-last-revoke", (_req, res) => {
  res.json({ requestingUserId: _lastRevokeRequestingUserId });
});

// PATCH /clerk-stub/organizations/:orgId/memberships/:userId — update role
app.patch("/clerk-stub/organizations/:orgId/memberships/:userId", (req, res) => {
  if (_clerkMembershipFailMode) {
    res.status(500).json({ error: "simulated clerk api error" }); return;
  }
  const { orgId, userId } = req.params;
  const { role } = req.body as { role?: string };
  const members = _clerkOrgMembersMap.get(orgId) ?? [];
  const idx = members.findIndex((m) => m.userId === userId);
  if (idx === -1) { res.status(404).json({ errors: [{ code: "resource_not_found" }] }); return; }
  members[idx] = { ...members[idx], role: role ?? members[idx].role };
  _clerkOrgMembersMap.set(orgId, members);
  res.json({ id: userId, role: members[idx].role });
});

// DELETE /clerk-stub/organizations/:orgId/memberships/:userId — remove member
app.delete("/clerk-stub/organizations/:orgId/memberships/:userId", (req, res) => {
  if (_clerkMembershipFailMode) {
    res.status(500).json({ error: "simulated clerk api error" }); return;
  }
  const { orgId, userId } = req.params;
  const members = _clerkOrgMembersMap.get(orgId) ?? [];
  const idx = members.findIndex((m) => m.userId === userId);
  if (idx === -1) { res.status(404).json({ errors: [{ code: "resource_not_found" }] }); return; }
  _clerkOrgMembersMap.set(orgId, members.filter((_, i) => i !== idx));
  res.json({ deleted: true });
});

// POST /test/set-clerk-invitation-fail { fail: bool }
app.post("/test/set-clerk-invitation-fail", (req, res) => {
  _clerkInvitationFailMode = !!(req.body as { fail?: boolean }).fail;
  res.json({ ok: true, clerkInvitationFailMode: _clerkInvitationFailMode });
});

// GET /test/get-last-invite — returns { redirectUrl } of the most recently created invitation
app.get("/test/get-last-invite", (_req, res) => {
  res.json({ redirectUrl: _lastCreatedInvitation?.redirectUrl ?? null });
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
  _missingFlyAppIds.clear();
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
  // Reject requests with the wrong Authorization header — mirrors Fly's auth behaviour.
  const expectedAuth = flyAuthHeader(process.env.FLY_API_TOKEN ?? "");
  if (req.headers.authorization !== expectedAuth) {
    res.status(401).json({ error: "unauthorized" }); return;
  }
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
  // Clear the 60s admin-stats cache so this test data is seen immediately
  const { _clearMetricsCacheForTest } = require("../src/lib/flyMetrics") as typeof import("../src/lib/flyMetrics");
  _clearMetricsCacheForTest();
  res.json({ ok: true });
});

// POST /test/set-prometheus-fail { fail: bool }
app.post("/test/set-prometheus-fail", (req, res) => {
  _promFailMode = !!(req.body as { fail?: boolean }).fail;
  const { _clearMetricsCacheForTest } = require("../src/lib/flyMetrics") as typeof import("../src/lib/flyMetrics");
  _clearMetricsCacheForTest();
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
const { orgsRouter } = require("../src/routes/orgs") as typeof import("../src/routes/orgs");
app.use("/health", healthRouter);
app.use("/v1/auth", authRouter);
app.use("/v1/apps/:id/access", appAccessRouter);
app.use("/v1/apps/:id/env", appEnvRouter);
app.use("/v1/apps", appsRouter);
app.use("/v1/orgs", orgsRouter);
app.use("/v1/api-keys", apiKeysRouter);
app.use("/v1/deployments/intake", intakeRouter);
app.use("/v1/deployments", deployStreamRouter);
app.use("/v1/deployments", deploymentsRouter);
app.use("/v1/proxy", proxyRouter);
app.use("/v1/me", meRouter);
app.use("/v1/workspace", workspaceRouter);
app.use("/v1/admin/stats", adminStatsRouter);
app.use("/v1/admin/activity", activityAdminRouter);
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
