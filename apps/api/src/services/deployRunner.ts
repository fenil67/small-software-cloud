import path from "path";
import os from "os";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import unzipper from "unzipper";
import { pool } from "../db";
import { eventBus } from "../lib/eventBus";
import { createFlyApp, destroyFlyApp } from "./flyClient";

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

async function getApp(appId: string): Promise<{ fly_app_id: string | null; name: string }> {
  const { rows } = await pool.query<{ fly_app_id: string | null; name: string }>(
    "SELECT fly_app_id, name FROM apps WHERE id = $1",
    [appId],
  );
  if (!rows[0]) throw new DeployError("internal", "App record not found.");
  return rows[0];
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
    await execFileP("git", ["clone", "--depth=1", githubUrl, dir]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not found") || msg.includes("Repository not found") || msg.includes("128")) {
      throw new DeployError("clone", "Repository not found or is private. Make sure the URL is correct and the repo is public.");
    }
    throw new DeployError("clone", "Failed to clone repository. Check that the URL is a valid public GitHub repo.");
  }
  return dir;
}

function detectDockerfile(dir: string): boolean {
  return fs.existsSync(path.join(dir, "Dockerfile")) || fs.existsSync(path.join(dir, "dockerfile"));
}

async function generateDockerfile(dir: string): Promise<void> {
  // Simple Node.js Dockerfile generation
  const dockerfile = `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 8080
CMD ["node", "index.js"]
`;
  fs.writeFileSync(path.join(dir, "Dockerfile"), dockerfile);
}

async function runFlyctlDeploy(
  dir: string,
  appName: string,
  deploymentId: string,
): Promise<string> {
  log(deploymentId, `Deploying to Fly app: ${appName}`);

  const outputLines: string[] = [];

  return new Promise<string>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const proc = require("child_process").spawn(
      "flyctl",
      ["deploy", "--app", appName, "--remote-only", "--ha=false", "--json"],
      { cwd: dir, env: { ...process.env } },
    );

    proc.stdout.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        outputLines.push(line);
        log(deploymentId, line);
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        outputLines.push(line);
      }
    });

    proc.on("close", (code: number) => {
      if (code !== 0) {
        const tail = outputLines.slice(-20).join("\n");
        reject(new DeployError("deploy", `Build or deploy failed. Last output:\n${tail}`));
        return;
      }
      // Extract machine ID from JSON output if possible
      try {
        const jsonLine = outputLines.find((l) => l.startsWith("{"));
        if (jsonLine) {
          const parsed = JSON.parse(jsonLine) as { id?: string };
          resolve(parsed.id ?? "");
          return;
        }
      } catch {}
      resolve("");
    });
  });
}

export async function runDeploy(args: RunDeployArgs): Promise<void> {
  const { deploymentId, appId, zipBuffer, githubUrl } = args;

  let flyAppName: string | null = null;
  let flyAppCreatedThisRun = false;
  let workDir: string | null = null;

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
      destroyFlyApp(flyAppName).catch(() => {});
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

    // Step 2: ensure Dockerfile
    if (!detectDockerfile(workDir)) {
      log(deploymentId, "No Dockerfile found; generating one…");
      await generateDockerfile(workDir);
    }

    // Step 3: ensure Fly app exists
    const app = await getApp(appId);
    let appName: string;
    if (app.fly_app_id) {
      appName = app.fly_app_id;
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

    // Step 4: deploy
    await updateDeploymentStatus(deploymentId, "deploying");
    eventBus.emit(deploymentId, { type: "status", status: "deploying" });

    const machineId = await runFlyctlDeploy(workDir, appName, deploymentId);

    // Step 5: success
    const appUrl = `https://${appName}.fly.dev`;
    await pool.query(
      `UPDATE apps SET subdomain = $1 WHERE id = $2`,
      [appUrl, appId],
    );
    await updateDeploymentStatus(deploymentId, "success", {
      fly_machine_id: machineId || undefined,
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
      console.error("[deploy] unexpected:", err);
    }
  } finally {
    if (workDir) {
      fs.rm(workDir, { recursive: true, force: true }, () => {});
    }
  }
}
