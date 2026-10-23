/**
 * Minimal test server.
 * - Uses API-key auth only (no Clerk middleware needed)
 * - Stubs flyClient so no real Fly API calls are made
 * - Stubs deployRunner so deploys return quickly with predictable results
 * - Reads DATABASE_URL from env (point at ssc_test)
 */

// Must be set before any imports
process.env.FLY_API_TOKEN = "test-token";
process.env.FLY_ORG_SLUG = "test-org";
process.env.CLERK_SECRET_KEY = "sk_test_stubstubstubstub";
process.env.SSC_TEST = "1";

import express from "express";
import { healthRouter } from "../src/routes/health";
import { appsRouter } from "../src/routes/apps";
import { deploymentsRouter } from "../src/routes/deployments";
import { deployStreamRouter } from "../src/routes/deployStream";
import { intakeRouter } from "../src/routes/intake";
import { apiKeysRouter } from "../src/routes/apiKeys";
import { authRouter } from "../src/routes/auth";
import { startReaper } from "../src/lib/reaper";
import { eventBus } from "../src/lib/eventBus";
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
flyModule.destroyFlyApp = async () => {};
flyModule.allocateFlyIp = async () => "1.2.3.4";

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

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

// NOTE: no clerkMiddleware() — we only test API-key auth paths
app.use("/health", healthRouter);
app.use("/v1/auth", authRouter);
app.use("/v1/apps", appsRouter);
app.use("/v1/api-keys", apiKeysRouter);
app.use("/v1/deployments/intake", intakeRouter);
app.use("/v1/deployments", deployStreamRouter);
app.use("/v1/deployments", deploymentsRouter);
app.use((_req, res) => res.status(404).json({ error: "not_found" }));

startReaper();

const PORT = parseInt(process.env.TEST_PORT ?? "4099");
app.listen(PORT, () => {
  process.stdout.write(`[test-server] ready on :${PORT}\n`);
});

export { app };
