/**
 * Deploy orchestrator.
 *
 * Flow:
 *   1. Extract code (zip → temp dir, or git clone → temp dir)
 *   2. Detect app type
 *   3. Generate Dockerfile + fly.toml
 *   4. Create Fly app via REST API
 *   5. Run `flyctl deploy --remote-only` as subprocess, streaming output
 *   6. Persist result to DB (apps + deployments tables)
 *   7. Clean up temp dir
 *
 * All progress is emitted on the eventBus so the SSE stream stays live.
 */

import { spawn } from "child_process";
import path from "path";
import { Readable } from "stream";
import unzipper from "unzipper";
import fs from "fs/promises";
import { pool } from "../db";
import { eventBus } from "../lib/eventBus";
import { makeTempDir, removeTempDir } from "../lib/tempDir";
import { detectAppType } from "./appDetector";
import { generateDeployFiles } from "./dockerfileGen";
import { createFlyApp, flyAppExists, listMachines } from "./flyClient";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(deploymentId: string, message: string) {
  console.log(`[deploy:${deploymentId.slice(0, 8)}] ${message}`);
  eventBus.emit(deploymentId, { type: "log", message });
}

function setStatus(deploymentId: string, status: "queued" | "building" | "deploying" | "success" | "failed") {
  eventBus.emit(deploymentId, { type: "status", status });
}

/** Generate a Fly-safe app name: ssc-{8 random alphanumeric chars} */
function generateFlyAppName(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (let i = 0; i < 8; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `ssc-${suffix}`;
}

// ─── Extract ─────────────────────────────────────────────────────────────────

/** Unzip a Buffer or Readable into a temp directory. Returns the dir path. */
async function extractZip(zipSource: Buffer | Readable, deploymentId: string): Promise<string> {
  const dir = await makeTempDir("ssc-zip");
  log(deploymentId, "Extracting zip archive…");

  const stream = Buffer.isBuffer(zipSource) ? Readable.from(zipSource) : zipSource;

  await new Promise<void>((resolve, reject) => {
    stream
      .pipe(unzipper.Extract({ path: dir }))
      .on("close", resolve)
      .on("error", reject);
  });

  // Unzip often creates a single top-level folder; unwrap it if so
  const entries = await fs.readdir(dir);
  if (entries.length === 1) {
    const inner = path.join(dir, entries[0]);
    const stat = await fs.stat(inner);
    if (stat.isDirectory()) {
      return inner;
    }
  }

  return dir;
}

/** Shallow git clone into a temp directory. Returns the dir path. */
async function cloneRepo(githubUrl: string, deploymentId: string): Promise<string> {
  const dir = await makeTempDir("ssc-git");
  log(deploymentId, `Cloning ${githubUrl}…`);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("git", ["clone", "--depth=1", githubUrl, dir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout.on("data", (d: Buffer) => log(deploymentId, d.toString().trim()));
    proc.stderr.on("data", (d: Buffer) => log(deploymentId, d.toString().trim()));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git clone exited with code ${code}`));
    });
  });

  return dir;
}

// ─── flyctl subprocess ───────────────────────────────────────────────────────

/**
 * Run `flyctl deploy --remote-only --app <name>` in `codeDir`.
 * Streams stdout/stderr to the event bus.
 * Returns when the process exits; throws if exit code is non-zero.
 */
async function runFlyctlDeploy(
  codeDir: string,
  appName: string,
  deploymentId: string
): Promise<void> {
  log(deploymentId, `Running flyctl deploy --remote-only --ha=false --app ${appName}…`);

  const env = {
    ...process.env,
    FLY_API_TOKEN: process.env.FLY_API_TOKEN ?? "",
    // Prevent flyctl from trying interactive input
    CI: "true",
  };

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      "flyctl",
      // --ha=false: deploy exactly one machine; without this Fly creates a second
      //             machine for high-availability by default, doubling costs.
      // --yes: accept any prompts non-interactively (same as CI=true but explicit)
      ["deploy", "--remote-only", "--ha=false", "--app", appName, "--yes"],
      { cwd: codeDir, stdio: ["ignore", "pipe", "pipe"], env }
    );

    proc.stdout.on("data", (chunk: Buffer) => {
      chunk
        .toString()
        .split("\n")
        .filter(Boolean)
        .forEach((line) => log(deploymentId, line));
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      chunk
        .toString()
        .split("\n")
        .filter(Boolean)
        .forEach((line) => log(deploymentId, line));
    });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`flyctl deploy exited with code ${code}`));
    });
  });
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function updateDeploymentStatus(
  deploymentId: string,
  status: "building" | "deploying" | "success" | "failed",
  extra: Partial<{
    fly_machine_id: string;
    error_message: string;
    finished_at: Date;
    started_at: Date;
  }> = {}
) {
  const fields: string[] = ["status = $2"];
  const values: unknown[] = [deploymentId, status];

  let i = 3;
  for (const [key, val] of Object.entries(extra)) {
    fields.push(`${key} = $${i++}`);
    values.push(val);
  }

  await pool.query(
    `UPDATE deployments SET ${fields.join(", ")} WHERE id = $1`,
    values
  );
}

async function updateAppRecord(
  appId: string,
  flyAppId: string,
  subdomain: string,
  status: "running" | "failed"
) {
  await pool.query(
    "UPDATE apps SET fly_app_id = $2, subdomain = $3, status = $4, updated_at = now() WHERE id = $1",
    [appId, flyAppId, subdomain, status]
  );
}

// ─── Main orchestrator ───────────────────────────────────────────────────────

export interface DeployInput {
  deploymentId: string;
  appId: string;
  /** Mutually exclusive: provide one */
  zipBuffer?: Buffer;
  githubUrl?: string;
}

export async function runDeploy(input: DeployInput): Promise<void> {
  const { deploymentId, appId } = input;
  let codeDir: string | null = null;
  let tempRoot: string | null = null;

  try {
    // ── Step 1: Update DB to building ──────────────────────────────────────
    setStatus(deploymentId, "building");
    await updateDeploymentStatus(deploymentId, "building", { started_at: new Date() });

    // ── Step 2: Extract code ───────────────────────────────────────────────
    if (input.zipBuffer) {
      tempRoot = await makeTempDir("ssc-root");
      codeDir = await extractZip(input.zipBuffer, deploymentId);
    } else if (input.githubUrl) {
      codeDir = await cloneRepo(input.githubUrl, deploymentId);
      tempRoot = codeDir;
    } else {
      throw new Error("No code source provided");
    }

    // ── Step 3: Detect app type ────────────────────────────────────────────
    log(deploymentId, "Detecting app type…");
    const appType = await detectAppType(codeDir);
    log(deploymentId, `Detected: ${appType.kind}`);

    // ── Step 4: Get app name from DB ───────────────────────────────────────
    const { rows: appRows } = await pool.query(
      "SELECT fly_app_id, slug FROM apps WHERE id = $1",
      [appId]
    );
    const app = appRows[0];
    if (!app) throw new Error(`App record ${appId} not found`);

    const flyAppName: string = app.fly_app_id ?? generateFlyAppName();

    // Persist the Fly app name back to DB if we just generated it
    if (!app.fly_app_id) {
      await pool.query("UPDATE apps SET fly_app_id = $2 WHERE id = $1", [appId, flyAppName]);
    }

    // ── Step 5: Generate Dockerfile + fly.toml ────────────────────────────
    log(deploymentId, "Generating deploy config…");
    await generateDeployFiles(codeDir, flyAppName, appType);

    // ── Step 6: Create Fly app (idempotent) ───────────────────────────────
    const orgSlug = process.env.FLY_ORG_SLUG ?? "personal";
    const exists = await flyAppExists(flyAppName);
    if (!exists) {
      log(deploymentId, `Creating Fly app "${flyAppName}"…`);
      await createFlyApp(flyAppName, orgSlug);
    } else {
      log(deploymentId, `Fly app "${flyAppName}" already exists.`);
    }

    // ── Step 7: Deploy ─────────────────────────────────────────────────────
    setStatus(deploymentId, "deploying");
    await updateDeploymentStatus(deploymentId, "deploying");

    await runFlyctlDeploy(codeDir, flyAppName, deploymentId);

    // ── Step 8: Get the machine ID from Fly ────────────────────────────────
    let machineId: string | undefined;
    try {
      const machines = await listMachines(flyAppName);
      machineId = machines[0]?.id;
    } catch {
      // non-fatal — we can still record success without the machine ID
    }

    // ── Step 9: Persist success ────────────────────────────────────────────
    const publicUrl = `https://${flyAppName}.fly.dev`;

    await updateDeploymentStatus(deploymentId, "success", {
      fly_machine_id: machineId,
      finished_at: new Date(),
    });
    await updateAppRecord(appId, flyAppName, `${flyAppName}.fly.dev`, "running");

    setStatus(deploymentId, "success");
    eventBus.emit(deploymentId, { type: "url", url: publicUrl });
    log(deploymentId, `✓ Deployed at ${publicUrl}`);
    eventBus.emit(deploymentId, { type: "done" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[deploy:${deploymentId.slice(0, 8)}] FAILED: ${message}`);

    await updateDeploymentStatus(deploymentId, "failed", {
      error_message: message,
      finished_at: new Date(),
    }).catch(() => {}); // don't let DB failure mask the original error

    await updateAppRecord(appId, "", "", "failed").catch(() => {});

    setStatus(deploymentId, "failed");
    eventBus.emit(deploymentId, { type: "error", message });
    eventBus.emit(deploymentId, { type: "done" });
  } finally {
    // Clean up temp dir regardless of outcome
    if (tempRoot) await removeTempDir(tempRoot);
    else if (codeDir) await removeTempDir(codeDir);

    // Give SSE subscribers a moment to receive the final events before cleanup
    setTimeout(() => eventBus.cleanup(deploymentId), 10_000);
  }
}
