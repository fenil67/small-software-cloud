import path from "path";
import os from "os";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import unzipper from "unzipper";
import { pool } from "../db";
import { eventBus } from "../lib/eventBus";
import { createFlyApp, destroyFlyApp, checkFlyAppExists } from "./flyClient";
import { safeErr, scrubSecrets } from "../lib/safeErr";
import { gitEnv, flyctlEnv } from "../lib/childEnv";
import { detectAppType } from "./appDetector";
import { generateDeployFiles } from "./dockerfileGen";

const execFileP = promisify(execFile);

interface RunDeployArgs {
  deploymentId: string;
  appId: string;
  zipBuffer?: Buffer;
  githubUrl?: string;
}

class DeployError extends Error {
  constructor(public stage: string, public userMessage: string) {
    super(userMessage);
  }
}

function log(deploymentId: string, message: string): void {
  eventBus.emit(deploymentId, { type: "log", message });
}

async function updateDeploymentStatus(
  deploymentId: string,
  status: string,
  extra: {
    fly_machine_id?: string;
    failure_stage?: string;
    failure_message?: string;
    finished?: boolean;
  } = {},
): Promise<void> {
  const sets: string[] = ["status = $2"];
  const vals: unknown[] = [deploymentId, status];
  let i = 3;
  if (extra.fly_machine_id) { sets.push(`fly_machine_id = $${i++}`); vals.push(extra.fly_machine_id); }
  if (extra.failure_stage) { sets.push(`failure_stage = $${i++}`); vals.push(extra.failure_stage); }
  if (extra.failure_message) { sets.push(`failure_message = $${i++}`); vals.push(extra.failure_message); }
  if (extra.finished) { sets.push(`finished_at = now()`); }
  await pool.query(`UPDATE deployments SET ${sets.join(", ")} WHERE id = $1`, vals);
}

async function getApp(appId: string): Promise<{ fly_app_id: string | null; name: string; org_id: string }> {
  const { rows } = await pool.query<{ fly_app_id: string | null; name: string; org_id: string }>(
    "SELECT fly_app_id, name, org_id FROM apps WHERE id = $1",
    [appId],
  );
  if (!rows[0]) throw new DeployError("internal", "App record not found.");
  return rows[0];
}

// ─── Destroy with retry + orphan recording ────────────────────────────────────

const DESTROY_MAX_ATTEMPTS = 3; // 1 initial + 2 retries
const DESTROY_BACKOFF_MS = [200, 600]; // waits between attempts 1→2 and 2→3

async function destroyWithRetry(flyAppName: string, orgId: string | null): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < DESTROY_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((r) =>
        setTimeout(r, DESTROY_BACKOFF_MS[attempt - 1] ?? 1000),
      );
    }
    try {
      await destroyFlyApp(flyAppName);
      return; // success — destroyFlyApp already treats 404 as success
    } catch (e) {
      lastErr = e;
    }
  }
  // All attempts exhausted — log and persist for reaper cleanup
  console.error(
    `[deploy] FAILED to destroy Fly app ${flyAppName} — it may still be running and billing:`,
    safeErr(lastErr),
  );
  try {
    await pool.query(
      `INSERT INTO orphaned_fly_apps (fly_app_name, org_id, last_error)
       VALUES ($1, $2, $3)
       ON CONFLICT (fly_app_name) DO UPDATE
         SET org_id     = COALESCE(EXCLUDED.org_id, orphaned_fly_apps.org_id),
             last_error = EXCLUDED.last_error`,
      [flyAppName, orgId, String(safeErr(lastErr))],
    );
  } catch (dbErr) {
    console.error("[deploy] failed to record orphaned Fly app in DB:", safeErr(dbErr));
  }
}

function generateFlyAppName(): string {
  return `ssc-${Math.random().toString(36).slice(2, 10)}`;
}

async function extractZip(zipBuffer: Buffer, deploymentId: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ssc-${deploymentId.slice(0, 8)}-`));
  const directory = await unzipper.Open.buffer(zipBuffer);
  const resolvedDir = path.resolve(dir);

  for (const file of directory.files) {
    if ((file.type as string) === "SymbolicLink") continue;
    const normalized = path.normalize(file.path.replace(/\\/g, "/"));
    const dest = path.resolve(dir, normalized);
    if (dest !== resolvedDir && !dest.startsWith(resolvedDir + path.sep)) continue;

    if ((file.type as string) === "Directory") {
      fs.mkdirSync(dest, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        const ws = fs.createWriteStream(dest);
        file.stream().pipe(ws);
        ws.on("finish", resolve);
        ws.on("error", reject);
      });
    }
  }
  return dir;
}

async function cloneRepo(githubUrl: string, deploymentId: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ssc-${deploymentId.slice(0, 8)}-`));
  try {
    await execFileP("git", ["clone", "--depth=1", githubUrl, dir], { env: gitEnv() });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not found") || msg.includes("Repository not found") || msg.includes("128")) {
      throw new DeployError("clone", "Repository not found or is private. Make sure the URL is correct and the repo is public.");
    }
    throw new DeployError("clone", "Failed to clone repository. Check that the URL is a valid public GitHub repo.");
  }
  return dir;
}


// Exported for unit testing (fake flyctl binary on PATH).
export async function runFlyctlDeploy(
  dir: string,
  appName: string,
  deploymentId: string,
): Promise<void> {
  log(deploymentId, `Deploying to Fly app: ${appName}`);

  const outputLines: string[] = [];

  return new Promise<void>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const proc = require("child_process").spawn(
      "flyctl",
      // --remote-only: build on Fly's remote builders, not locally
      // --ha=false:    deploy exactly one machine (avoid the default HA pair)
      // --yes:         accept any interactive prompts non-interactively (CI-safe)
      ["deploy", "--remote-only", "--ha=false", "--app", appName, "--yes"],
      {
        cwd: dir,
        env: flyctlEnv(),
      },
    );

    proc.stdout.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        const scrubbed = scrubSecrets(line);
        outputLines.push(scrubbed);
        log(deploymentId, scrubbed);
      }
    });
    // stderr carries flyctl progress, warnings, and error messages — send it
    // to the SSE stream the same way as stdout so users see it in real time.
    proc.stderr.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        const scrubbed = scrubSecrets(line);
        outputLines.push(scrubbed);
        log(deploymentId, scrubbed);
      }
    });

    // Without this handler, a missing flyctl binary raises ENOENT outside the
    // Promise and the catch block in runDeploy never fires, leaving the SSE
    // stream stuck on keep-alive pings.
    proc.on("error", reject);

    proc.on("close", (code: number) => {
      if (code !== 0) {
        // When flyctl gets an unrecognised flag it prints ~20 lines of usage
        // text instead of a useful error.  Detect that case and surface only
        // the single "Error:" line so the failure message stays actionable.
        const isUsageOutput = outputLines.some(
          (l) => l.includes("Usage:") || l.includes("Global Flags:"),
        );
        let detail: string;
        if (isUsageOutput) {
          const errorLine =
            outputLines.find((l) => l.startsWith("Error:")) ??
            outputLines.slice(-1)[0] ??
            "Unknown error";
          detail = errorLine;
        } else {
          detail = `Last output:\n${outputLines.slice(-20).join("\n")}`;
        }
        reject(new DeployError("deploy", `Build or deploy failed. ${scrubSecrets(detail)}`));
        return;
      }
      resolve();
    });
  });
}

export async function runDeploy(args: RunDeployArgs): Promise<void> {
  const { deploymentId, appId, zipBuffer, githubUrl } = args;

  let flyAppName: string | null = null;
  let flyAppCreatedThisRun = false;
  let workDir: string | null = null;
  let orgId: string | null = null; // captured in Step 3 for orphan recording

  const fail = async (err: DeployError): Promise<void> => {
    console.error(`[deploy] ${deploymentId} failed at ${err.stage}: ${err.message}`);
    await updateDeploymentStatus(deploymentId, "failed", {
      failure_stage: err.stage,
      failure_message: err.userMessage,
      finished: true,
    });
    eventBus.emit(deploymentId, { type: "error", stage: err.stage, message: err.userMessage });
    eventBus.emit(deploymentId, { type: "status", status: "failed" });
    eventBus.emit(deploymentId, { type: "done" });

    if (flyAppCreatedThisRun && flyAppName) {
      // Clear fly_app_id BEFORE destroying the Fly app so any concurrent read
      // sees NULL rather than a name that no longer exists.  A failed redeploy
      // will then create a fresh Fly app instead of trying to target the deleted one.
      await pool.query(
        "UPDATE apps SET fly_app_id = NULL WHERE id = $1",
        [appId],
      ).catch((e) => console.error("[deploy] failed to clear fly_app_id:", safeErr(e)));
      // Retry destroy up to 3 times; on total failure, log with safeErr and
      // record the app name for the reaper to clean up later.
      await destroyWithRetry(flyAppName, orgId);
    }
    if (workDir) {
      fs.rm(workDir, { recursive: true, force: true }, () => {});
    }
  };

  try {
    await updateDeploymentStatus(deploymentId, "building");
    eventBus.emit(deploymentId, { type: "status", status: "building" });

    // Step 1: get/prepare source
    if (zipBuffer) {
      log(deploymentId, "Extracting zip…");
      workDir = await extractZip(zipBuffer, deploymentId);
    } else if (githubUrl) {
      log(deploymentId, `Cloning ${githubUrl}…`);
      workDir = await cloneRepo(githubUrl, deploymentId);
    } else {
      throw new DeployError("internal", "No source provided.");
    }

    // Step 2: detect app type (fast-fail before provisioning)
    log(deploymentId, "Detecting app type…");
    let appType: Awaited<ReturnType<typeof detectAppType>>;
    try {
      appType = await detectAppType(workDir);
      log(deploymentId, `Detected: ${appType.kind}`);
    } catch (err) {
      throw new DeployError(
        "detect",
        err instanceof Error ? err.message : "Could not detect app type.",
      );
    }

    // Step 3: ensure Fly app exists
    const app = await getApp(appId);
    orgId = app.org_id; // needed by destroyWithRetry inside fail()
    let appName: string;
    if (app.fly_app_id) {
      appName = app.fly_app_id;
      // The Fly app may have been destroyed externally (or by a pre-fix failed
      // first-deploy that cleared fly_app_id late / not at all).  Verify it
      // still exists; if not, treat it like a brand-new app.
      let flyAppFound = false;
      try {
        flyAppFound = await checkFlyAppExists(appName);
      } catch {
        // If the existence check itself errors, assume missing and recreate.
        flyAppFound = false;
      }
      if (!flyAppFound) {
        const newName = generateFlyAppName();
        log(deploymentId, `Fly app ${appName} not found — recreating as ${newName}`);
        appName = newName;
        try {
          await createFlyApp(appName, process.env.FLY_ORG_SLUG!);
        } catch (err) {
          throw new DeployError("provision", "Failed to create app on Fly.io. Please try again.");
        }
        flyAppCreatedThisRun = true;
        flyAppName = appName;
        await pool.query("UPDATE apps SET fly_app_id = $1 WHERE id = $2", [appName, appId]);
      }
    } else {
      appName = generateFlyAppName();
      log(deploymentId, `Creating Fly app: ${appName}`);
      try {
        await createFlyApp(appName, process.env.FLY_ORG_SLUG!);
      } catch (err) {
        throw new DeployError("provision", "Failed to create app on Fly.io. Please try again.");
      }
      flyAppCreatedThisRun = true;
      flyAppName = appName;
      await pool.query("UPDATE apps SET fly_app_id = $1 WHERE id = $2", [appName, appId]);
    }
    flyAppName = appName;

    // Step 3b: generate Dockerfile + fly.toml (lockfile-aware for Node)
    log(deploymentId, "Generating deploy files…");
    try {
      await generateDeployFiles(workDir, appName, appType);
    } catch (err) {
      throw new DeployError(
        "provision",
        err instanceof Error ? err.message : "Failed to generate deploy files.",
      );
    }

    // Step 4: deploy
    await updateDeploymentStatus(deploymentId, "deploying");
    eventBus.emit(deploymentId, { type: "status", status: "deploying" });

    await runFlyctlDeploy(workDir, appName, deploymentId);

    // Step 5: success
    // The live URL follows Fly's deterministic pattern; no JSON parsing needed.
    // fly_machine_id is left NULL — it is purely informational and would require
    // a separate listMachines() API call that isn't worth the extra latency here.
    const appUrl = `https://${appName}.fly.dev`;
    await pool.query(
      `UPDATE apps SET subdomain = $1 WHERE id = $2`,
      [appUrl, appId],
    );
    await updateDeploymentStatus(deploymentId, "success", {
      finished: true,
    });
    eventBus.emit(deploymentId, { type: "url", url: appUrl });
    eventBus.emit(deploymentId, { type: "status", status: "success" });
    eventBus.emit(deploymentId, { type: "done" });

    log(deploymentId, `Deploy complete: ${appUrl}`);
  } catch (err: unknown) {
    if (err instanceof DeployError) {
      await fail(err);
    } else {
      await fail(new DeployError("internal", "An unexpected error occurred. Please try again."));
      console.error("[deploy] unexpected:", safeErr(err));
    }
  } finally {
    if (workDir) {
      fs.rm(workDir, { recursive: true, force: true }, () => {});
    }
  }
}
