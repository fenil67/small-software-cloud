/**
 * One-shot script: creates a bare Node test case in a temp dir,
 * runs detectAppType + generateDeployFiles, and prints the results.
 *
 * Usage: pnpm exec tsx scripts/test-detection.ts
 */
import { detectAppType } from "../src/services/appDetector";
import { generateDeployFiles } from "../src/services/dockerfileGen";
import fs from "fs/promises";
import path from "path";
import os from "os";

async function main() {
  // ── 1. Create the bare test case ──────────────────────────────────────────
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssc-bare-node-"));

  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify(
      { name: "bare-hello", version: "1.0.0", scripts: { start: "node index.js" } },
      null,
      2
    )
  );
  await fs.writeFile(
    path.join(dir, "index.js"),
    [
      'const http = require("http");',
      'const server = http.createServer((_, res) => { res.end("hello world\\n"); });',
      "server.listen(process.env.PORT || 8080, () => console.log('listening'));",
    ].join("\n")
  );

  console.log("=== Bare test case contents ===");
  const beforeFiles = await fs.readdir(dir);
  for (const f of beforeFiles) console.log(`  ${f}`);

  // ── 2. Run detection ──────────────────────────────────────────────────────
  const appType = await detectAppType(dir);
  console.log("\n=== detectAppType result ===");
  console.log(JSON.stringify(appType, null, 2));

  // ── 3. Run generation ─────────────────────────────────────────────────────
  const { internalPort } = await generateDeployFiles(dir, "ssc-testapp", appType);
  console.log(`\n=== generateDeployFiles completed (internalPort=${internalPort}) ===`);

  const afterFiles = await fs.readdir(dir);
  console.log("\n=== Files now in dir ===");
  for (const f of afterFiles) console.log(`  ${f}`);

  // ── 4. Print generated files ──────────────────────────────────────────────
  for (const f of ["Dockerfile", "fly.toml"]) {
    const fullPath = path.join(dir, f);
    try {
      const content = await fs.readFile(fullPath, "utf8");
      console.log(`\n=== ${f} ===`);
      console.log(content);
    } catch {
      console.log(`\n=== ${f} === (NOT GENERATED)`);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await fs.rm(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
