/**
 * End-to-end deploy smoke test — bypasses the HTTP layer.
 * Creates a bare Node app, runs the full deploy pipeline, prints the live URL.
 *
 * Usage: pnpm exec tsx scripts/test-deploy.ts
 *
 * Requires: FLY_API_TOKEN and FLY_ORG_SLUG in apps/api/.env (or environment).
 */
import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { detectAppType } from "../src/services/appDetector";
import { generateDeployFiles } from "../src/services/dockerfileGen";
import { createFlyApp, flyAppExists } from "../src/services/flyClient";
import { spawn } from "child_process";

// ── Minimal bare Node app ───────────────────────────────────────────────────

async function createBareApp(dir: string) {
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify(
      { name: "ssc-bare-hello", version: "1.0.0", scripts: { start: "node index.js" } },
      null,
      2
    )
  );
  await fs.writeFile(
    path.join(dir, "index.js"),
    [
      'const http = require("http");',
      'const PORT = process.env.PORT || 8080;',
      'const server = http.createServer((req, res) => {',
      '  res.writeHead(200, { "Content-Type": "text/plain" });',
      '  res.end("hello from ssc bare node app\\n");',
      "});",
      "server.listen(PORT, () => console.log(`listening on ${PORT}`));",
    ].join("\n")
  );
}

// ── flyctl subprocess ───────────────────────────────────────────────────────

function runFlyctl(args: string[], cwd: string): Promise<void> {
  const flyctlBin = process.env.FLYCTL_BIN ?? "~/.fly/bin/flyctl";
  const bin = flyctlBin.replace(/^~/, os.homedir());

  console.log(`  $ ${bin} ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FLY_API_TOKEN: process.env.FLY_API_TOKEN ?? "",
        CI: "true",
      },
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      chunk.toString().split("\n").filter(Boolean).forEach((l) => console.log("  flyctl |", l));
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      chunk.toString().split("\n").filter(Boolean).forEach((l) => console.log("  flyctl |", l));
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`flyctl exited with code ${code}`));
    });
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.FLY_API_TOKEN) {
    console.error("FLY_API_TOKEN not set — add it to apps/api/.env");
    process.exit(1);
  }

  const orgSlug = process.env.FLY_ORG_SLUG ?? "personal";
  const appName = `ssc-bare-${Math.random().toString(36).slice(2, 10)}`;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssc-deploy-test-"));
  console.log(`\nTemp dir: ${dir}`);
  console.log(`Fly app name: ${appName}`);
  console.log(`Fly org: ${orgSlug}\n`);

  try {
    // Step 1: Create the bare app
    console.log("[1/6] Creating bare Node app...");
    await createBareApp(dir);
    console.log("      package.json + index.js written\n");

    // Step 2: Detect app type
    console.log("[2/6] Detecting app type...");
    const appType = await detectAppType(dir);
    console.log("      result:", JSON.stringify(appType));
    console.log();

    // Step 3: Generate Dockerfile + fly.toml
    console.log("[3/6] Generating Dockerfile + fly.toml...");
    const { internalPort } = await generateDeployFiles(dir, appName, appType);
    console.log(`      internalPort: ${internalPort}`);

    const dockerfile = await fs.readFile(path.join(dir, "Dockerfile"), "utf8");
    const flytoml = await fs.readFile(path.join(dir, "fly.toml"), "utf8");
    console.log("\n      --- Dockerfile ---");
    dockerfile.split("\n").forEach((l) => console.log("      " + l));
    console.log("\n      --- fly.toml ---");
    flytoml.split("\n").forEach((l) => console.log("      " + l));
    console.log();

    // Step 4: Create Fly app (idempotent)
    console.log("[4/6] Creating Fly app...");
    const exists = await flyAppExists(appName);
    if (!exists) {
      await createFlyApp(appName, orgSlug);
      console.log(`      Created: ${appName}`);
    } else {
      console.log(`      Already exists: ${appName}`);
    }
    console.log();

    // Step 5: Deploy via flyctl
    console.log("[5/6] Deploying via flyctl...");
    await runFlyctl(
      ["deploy", "--remote-only", "--ha=false", "--app", appName, "--yes"],
      dir
    );
    console.log();

    // Step 6: Report
    const url = `https://${appName}.fly.dev`;
    console.log("[6/6] Deploy complete!");
    console.log(`      URL: ${url}`);
    console.log(`\n  curl ${url}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    console.log("\nTemp dir cleaned up.");
  }
}

main().catch((err) => {
  console.error("\nDEPLOY FAILED:", err.message);
  process.exit(1);
});
