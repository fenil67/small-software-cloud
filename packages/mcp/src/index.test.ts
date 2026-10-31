/**
 * MCP server tests.
 *
 * Run with:
 *   pnpm test
 *   (or: node dist/index.test.js after pnpm build)
 *
 * Two suites:
 *   1. Rate limit — verifies checkRateLimit() blocks after 5 calls per 10 min.
 *   2. Tool descriptions — starts the server in-process via InMemoryTransport,
 *      calls tools/list, and asserts the description text contains the keywords
 *      that agents depend on (app_id, failure_message, failure_stage, etc.).
 */

import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  checkRateLimit,
  createServer,
  deployCallTimestamps,
  RATE_MAX_CALLS,
} from "./index";

// ── Minimal test harness ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label: string): void {
  console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  passed++;
}
function fail(label: string, detail?: string): void {
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `  (${detail})` : ""}`);
  failed++;
}
function section(title: string): void {
  console.log(`\n\x1b[1m── ${title} ──\x1b[0m`);
}

// ── Suite 1: Rate limit ───────────────────────────────────────────────────────

section("Rate limit");

// Reset module-level state so earlier require() calls don't pollute the count
deployCallTimestamps.length = 0;

// First RATE_MAX_CALLS calls must be allowed
for (let i = 0; i < RATE_MAX_CALLS; i++) {
  const r = checkRateLimit();
  r.allowed
    ? ok(`call ${i + 1} of ${RATE_MAX_CALLS} allowed`)
    : fail(`call ${i + 1} should be allowed`, r.message);
}

// Next call must be blocked
const blocked = checkRateLimit();
!blocked.allowed
  ? ok("call after limit is blocked")
  : fail("call after limit should be blocked");

blocked.message?.includes("Rate limit exceeded")
  ? ok("error message contains 'Rate limit exceeded'")
  : fail("error message should contain 'Rate limit exceeded'", blocked.message);

blocked.message?.includes(String(RATE_MAX_CALLS))
  ? ok(`error message mentions limit of ${RATE_MAX_CALLS}`)
  : fail(`error message should mention ${RATE_MAX_CALLS}`, blocked.message);

blocked.message?.includes("10 minutes")
  ? ok("error message mentions '10 minutes'")
  : fail("error message should mention '10 minutes'", blocked.message);

blocked.message?.toLowerCase().includes("stop") ||
blocked.message?.toLowerCase().includes("do not loop")
  ? ok("error message tells agent to stop retrying")
  : fail(
      "error message should tell agent to stop retrying",
      blocked.message,
    );

// After resetting timestamps the limit lifts
deployCallTimestamps.length = 0;
const afterReset = checkRateLimit();
afterReset.allowed
  ? ok("allowed again after timestamps reset")
  : fail("should allow after reset", afterReset.message);

// ── Suite 2: Tool descriptions via MCP tools/list ─────────────────────────────

section("Tool descriptions (MCP tools/list)");

(async () => {
  const server = createServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  const messages: unknown[] = [];
  clientTransport.onmessage = (msg) => messages.push(msg);
  await clientTransport.start();

  // MCP handshake
  clientTransport.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.1" },
    },
  });
  await new Promise((r) => setTimeout(r, 60));

  clientTransport.send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
  await new Promise((r) => setTimeout(r, 10));

  // tools/list
  clientTransport.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  await new Promise((r) => setTimeout(r, 60));

  const listResp = (messages as Array<{ id?: number; result?: { tools?: Array<{ name: string; description: string }> } }>)
    .find((m) => m.id === 2);

  const tools = listResp?.result?.tools ?? [];

  const deployTool = tools.find((t) => t.name === "deploy_app");
  const statusTool = tools.find((t) => t.name === "get_deployment_status");

  deployTool
    ? ok("deploy_app tool is listed")
    : fail("deploy_app tool missing from tools/list");
  statusTool
    ? ok("get_deployment_status tool is listed")
    : fail("get_deployment_status tool missing from tools/list");

  if (deployTool) {
    const desc = deployTool.description;

    // Keywords an agent depends on — if these regress, agents misbehave
    const required: Array<[string, string]> = [
      ["app_id", "agent guidance: save and reuse app_id"],
      ["failure_message", "agent guidance: read failure_message on failure"],
      ["failure_stage", "agent guidance: read failure_stage on failure"],
      ["3 times", "agent guidance: retry limit of 3"],
      ["home director", "refused input: home directory"],
      [".env", "files never uploaded: .env"],
    ];
    for (const [keyword, reason] of required) {
      desc.includes(keyword)
        ? ok(`deploy_app description contains "${keyword}" (${reason})`)
        : fail(
            `deploy_app description must contain "${keyword}" (${reason})`,
            `got: ${desc.slice(0, 100)}…`,
          );
    }
  } else {
    // Record failures for every required keyword so the count is accurate
    const required = ["app_id", "failure_message", "failure_stage", "3 times", "home director", ".env"];
    for (const keyword of required) {
      fail(`deploy_app description must contain "${keyword}" (skipped — tool missing)`);
    }
  }

  if (statusTool) {
    const desc = statusTool.description;
    desc.includes("failure_stage") && desc.includes("failure_message")
      ? ok("get_deployment_status description mentions failure_stage and failure_message")
      : fail("get_deployment_status description should mention failure_stage and failure_message");
    desc.includes("deployment_id")
      ? ok("get_deployment_status description mentions deployment_id")
      : fail("get_deployment_status description should mention deployment_id");
  }

  await server.close();

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log("\n\x1b[1m" + "─".repeat(50) + "\x1b[0m");
  console.log(
    `  \x1b[32mPassed: ${passed}\x1b[0m   ${
      failed > 0
        ? `\x1b[31mFailed: ${failed}\x1b[0m`
        : `\x1b[2mFailed: ${failed}\x1b[0m`
    }`,
  );

  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
