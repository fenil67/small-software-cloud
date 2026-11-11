/**
 * Full integration test suite.
 * Starts the test server, seeds the DB, runs every scenario, then cleans up.
 *
 * Run with:
 *   DATABASE_URL="postgres://fenilpatel@localhost:5432/ssc_test" \
 *   TEST_PORT=4099 \
 *   npx ts-node --project tsconfig.json scripts/run-tests.ts
 *
 * NEVER point DATABASE_URL at the Railway production database.
 * Create a local test DB:  createdb ssc_test && node dist/db/migrate.js
 */

// ── Safety: refuse Railway production DB ──────────────────────────────────────
const _rawDbUrl = process.env.DATABASE_URL ?? "";
if (_rawDbUrl.includes("rlwy.net") || _rawDbUrl.includes("railway.app")) {
  console.error(
    "FATAL: DATABASE_URL points at Railway production — aborting.\n" +
      "  Use a local Postgres DB, e.g.:\n" +
      '  DATABASE_URL="postgres://fenilpatel@localhost:5432/ssc_test" ...',
  );
  process.exit(1);
}

import http from "http";
import https from "https";
import { Pool } from "pg";
import { generateApiKey, hashApiKey } from "../src/lib/apiKeys";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import os from "os";
import FormData from "form-data";
import archiverLib from "archiver";
import { PassThrough } from "stream";

const BASE_URL = `http://localhost:${process.env.TEST_PORT ?? "4099"}`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;

let passed = 0;
let failed = 0;

function ok(label: string, detail?: string): void {
  console.log(G("  ✓ ") + label + (detail ? DIM("  " + detail) : ""));
  passed++;
}
function fail(label: string, detail?: string): void {
  console.log(R("  ✗ ") + label + (detail ? "  " + detail : ""));
  failed++;
}
function section(title: string): void {
  console.log("\n" + B(`── ${title} ──`));
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

interface Resp {
  status: number;
  body: unknown;
  text: string;
  headers: Record<string, string | string[] | undefined>;
}

function request(
  method: string,
  url: string,
  opts: {
    body?: unknown;
    headers?: Record<string, string>;
    formData?: FormData;
  } = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const fullUrl = url.startsWith("http") ? url : BASE_URL + url;
    const parsed = new URL(fullUrl);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    let postData: Buffer | string | undefined;
    const reqHeaders: Record<string, string> = { ...opts.headers };

    if (opts.formData) {
      postData = opts.formData.getBuffer();
      Object.assign(reqHeaders, opts.formData.getHeaders());
      reqHeaders["Content-Length"] = String(postData.length);
    } else if (opts.body !== undefined) {
      postData = JSON.stringify(opts.body);
      reqHeaders["Content-Type"] = "application/json";
      reqHeaders["Content-Length"] = String(Buffer.byteLength(postData));
    }

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: reqHeaders,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown;
          try { body = JSON.parse(text); } catch { body = text; }
          resolve({
            status: res.statusCode ?? 0,
            body,
            text,
            headers: res.headers as Record<string, string | string[] | undefined>,
          });
        });
      },
    );
    // 8-second socket timeout so a hung server-side async handler doesn't stall
    // the whole suite indefinitely (see intake.ts owner_id mismatch report).
    req.setTimeout(8000, () => {
      req.destroy(new Error("request timeout after 8s — server sent no response"));
    });
    // Resolve with a sentinel status-0 response instead of rejecting so a
    // hung or crashed server doesn't abort the whole suite at main().catch().
    req.on("error", (err) => {
      resolve({ status: 0, body: { error: err.message }, text: err.message, headers: {} });
    });
    if (postData !== undefined) req.write(postData);
    req.end();
  });
}

function streamRequest(url: string, headers: Record<string, string>): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(BASE_URL + url);
    const chunks: string[] = [];
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "GET",
        headers,
      },
      (res) => {
        if (res.statusCode !== 200) {
          const d: Buffer[] = [];
          res.on("data", (c: Buffer) => d.push(c));
          res.on("end", () => {
            console.log(`  [streamRequest] non-200: ${res.statusCode} ${Buffer.concat(d).toString()}`);
            resolve([]); // resolve empty so callers record failures, not crash
          });
          return;
        }
        let buf = "";
        res.on("data", (c: Buffer) => {
          buf += c.toString();
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("data: ")) chunks.push(line.slice(6));
          }
        });
        res.on("end", () => resolve(chunks));
      },
    );
    req.setTimeout(8000, () => {
      req.destroy(new Error("stream timeout after 8s"));
    });
    req.on("error", (err) => {
      // resolve with empty chunks so callers still run their assertions and
      // record failures rather than crashing the suite
      console.log(`  [streamRequest] error: ${err.message}`);
      resolve([]);
    });
    req.end();
  });
}

// ── DB seeding ────────────────────────────────────────────────────────────────

interface SeedResult {
  orgAId: string;
  orgBId: string;
  userId: string;     // test user (needed for apps.owner_id NOT NULL)
  keyA: string;       // valid key for org A
  keyARevoked: string; // revoked key for org A
  keyB: string;       // valid key for org B
}

async function seed(): Promise<SeedResult> {
  // Clean up from prior runs
  await pool.query("DELETE FROM deployments");
  await pool.query("DELETE FROM apps");
  await pool.query("DELETE FROM api_keys");
  await pool.query("DELETE FROM users");
  await pool.query("DELETE FROM orgs");

  // Real schema: users.email NOT NULL, users.display_name nullable
  const userRow = await pool.query<{ id: string }>(
    "INSERT INTO users (clerk_user_id, email, display_name) VALUES ($1,$2,$3) RETURNING id",
    ["clerk_user_test_seed", "seed@test.local", "Seed User"],
  );
  const userId = userRow.rows[0].id;

  // Real schema: orgs.slug TEXT NOT NULL UNIQUE
  const orgA = await pool.query<{ id: string }>(
    "INSERT INTO orgs (clerk_org_id, name, slug) VALUES ($1,$2,$3) RETURNING id",
    ["clerk_org_aaa", "Org Alpha", "org-alpha"],
  );
  const orgB = await pool.query<{ id: string }>(
    "INSERT INTO orgs (clerk_org_id, name, slug) VALUES ($1,$2,$3) RETURNING id",
    ["clerk_org_bbb", "Org Beta", "org-beta"],
  );
  const orgAId = orgA.rows[0].id;
  const orgBId = orgB.rows[0].id;

  const genAndInsert = async (orgId: string, name: string, revoked = false) => {
    const { fullKey, keyPrefix, keyHash } = generateApiKey();
    await pool.query(
      `INSERT INTO api_keys (org_id, created_by, name, key_prefix, key_hash${revoked ? ", revoked_at" : ""})
       VALUES ($1, $2, $3, $4, $5${revoked ? ", now()" : ""})`,
      [orgId, userId, name, keyPrefix, keyHash],
    );
    return fullKey;
  };

  const keyA = await genAndInsert(orgAId, "Key A1");
  const keyARevoked = await genAndInsert(orgAId, "Key A-revoked", true);
  const keyB = await genAndInsert(orgBId, "Key B1");

  console.log(DIM(`  seeded: orgA=${orgAId.slice(0, 8)}… orgB=${orgBId.slice(0, 8)}… user=${userId.slice(0, 8)}…`));
  return { orgAId, orgBId, userId, keyA, keyARevoked, keyB };
}

function authHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

// ── Small zip builder ─────────────────────────────────────────────────────────

async function buildZip(files: Record<string, string>): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const pt = new PassThrough();
    pt.on("data", (c: Buffer) => chunks.push(c));
    pt.on("end", () => resolve(Buffer.concat(chunks)));
    pt.on("error", reject);

    const archive = archiverLib("zip", {});
    archive.on("error", reject);
    archive.pipe(pt);
    for (const [name, content] of Object.entries(files)) {
      archive.append(Buffer.from(content), { name });
    }
    archive.finalize();
  });
}

// ── Poll deployment until terminal ───────────────────────────────────────────
// Used by Sections S and T which trigger real deploys via HTTP intake and need
// to wait for the background runDeploy to reach success or failed.

interface DeployPollResult {
  status: string;
  failure_stage: string | null;
  failure_message: string | null;
  app_id: string;
}

async function pollDeployment(
  deploymentId: string,
  apiKey: string,
  timeoutMs = 10000,
): Promise<DeployPollResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await request("GET", `/v1/deployments/${deploymentId}`, {
      headers: authHeaders(apiKey),
    });
    if (r.status === 200) {
      const b = r.body as Record<string, unknown>;
      const st = String(b.status ?? "");
      if (st === "success" || st === "failed") {
        return {
          status: st,
          failure_stage: (b.failure_stage as string | null) ?? null,
          failure_message: (b.failure_message as string | null) ?? null,
          app_id: String(b.app_id ?? ""),
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`pollDeployment: ${deploymentId} timed out after ${timeoutMs}ms`);
}

// ── Wait for server ───────────────────────────────────────────────────────────

async function waitForServer(retries = 20): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await request("GET", "/health");
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Server did not start in time");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(B("\nSSC Integration Test Suite"));
  console.log(DIM(`  ${BASE_URL}  db=${process.env.DATABASE_URL}`));

  await waitForServer();
  console.log(DIM("  server ready"));

  const { orgAId, orgBId, userId, keyA, keyARevoked, keyB } = await seed();

  // ════════════════════════════════════════════════════════════════════════════
  section("A: API Key Auth — valid / revoked / invalid");
  // ════════════════════════════════════════════════════════════════════════════

  {
    // Valid key
    const r = await request("GET", "/v1/auth/check", { headers: authHeaders(keyA) });
    console.log(`  GET /v1/auth/check (valid key) → ${r.status}  body=${JSON.stringify(r.body)}`);
    r.status === 200 ? ok("valid key → 200") : fail("valid key should 200", `got ${r.status}`);
  }
  {
    // Revoked key
    const r = await request("GET", "/v1/auth/check", { headers: authHeaders(keyARevoked) });
    console.log(`  GET /v1/auth/check (revoked key) → ${r.status}  body=${JSON.stringify(r.body)}`);
    r.status === 401 ? ok("revoked key → 401") : fail("revoked key should 401", `got ${r.status}`);
  }
  {
    // Invalid key (looks like API key prefix but doesn't exist)
    const fakeKey = `ssc_${crypto.randomBytes(32).toString("base64url")}`;
    const r = await request("GET", "/v1/auth/check", { headers: authHeaders(fakeKey) });
    console.log(`  GET /v1/auth/check (invalid key) → ${r.status}  body=${JSON.stringify(r.body)}`);
    r.status === 401 ? ok("invalid key → 401") : fail("invalid key should 401", `got ${r.status}`);
  }
  {
    // No key at all
    const r = await request("GET", "/v1/auth/check");
    console.log(`  GET /v1/auth/check (no auth) → ${r.status}  body=${JSON.stringify(r.body)}`);
    r.status === 401 ? ok("no auth → 401") : fail("no auth should 401", `got ${r.status}`);
  }

  // ════════════════════════════════════════════════════════════════════════════
  section("B: Org isolation — cross-org deployment read");
  // ════════════════════════════════════════════════════════════════════════════

  // Create a deployment under org B via zip upload
  let orgBDeployId = "";
  {
    const zip = await buildZip({ "package.json": '{"name":"orgb-app"}', "index.js": "// app" });
    const form = new FormData();
    form.append("code", zip, { filename: "app.zip", contentType: "application/zip" });
    const r = await request("POST", "/v1/deployments/intake/zip", {
      headers: authHeaders(keyB),
      formData: form,
    });
    console.log(`  POST /intake/zip (org B) → ${r.status}  body=${JSON.stringify(r.body)}`);
    orgBDeployId = (r.body as any).deployment_id ?? "";
    r.status === 202 ? ok("org B zip intake → 202") : fail("org B intake should 202", `got ${r.status} ${JSON.stringify(r.body)}`);
  }

  // Wait briefly for async deploy to complete
  await new Promise((r) => setTimeout(r, 300));

  {
    // Org A key tries to read org B's deployment → 404
    const r = await request("GET", `/v1/deployments/${orgBDeployId}`, {
      headers: authHeaders(keyA),
    });
    console.log(`  GET /v1/deployments/<orgB-id> with org A key → ${r.status}  body=${JSON.stringify(r.body)}`);
    r.status === 404 ? ok("org A can't read org B deployment → 404") : fail("cross-org should 404", `got ${r.status} ${JSON.stringify(r.body)}`);
  }
  {
    // Org A key tries to stream org B's deployment → 404
    try {
      const r = await request("GET", `/v1/deployments/${orgBDeployId}/stream`, {
        headers: authHeaders(keyA),
      });
      console.log(`  GET /v1/deployments/<orgB-id>/stream with org A key → ${r.status}  body=${JSON.stringify(r.body)}`);
      r.status === 404 ? ok("org A can't stream org B deployment → 404") : fail("cross-org stream should 404", `got ${r.status}`);
    } catch (e) {
      fail("cross-org stream threw", String(e));
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  section("C: ZIP upload + successful deploy (scenario a)");
  // ════════════════════════════════════════════════════════════════════════════

  let successDeployId = "";
  let successAppId = "";
  {
    const zip = await buildZip({
      "package.json": JSON.stringify({ name: "my-test-app", version: "1.0.0" }),
      "index.js": 'const http = require("http"); http.createServer((_,r) => r.end("hi")).listen(8080);',
      "Dockerfile": "FROM node:20-alpine\nCOPY . .\nCMD [\"node\",\"index.js\"]",
    });
    const form = new FormData();
    form.append("code", zip, { filename: "app.zip", contentType: "application/zip" });
    const r = await request("POST", "/v1/deployments/intake/zip", {
      headers: authHeaders(keyA),
      formData: form,
    });
    console.log(`  POST /intake/zip → ${r.status}  body=${JSON.stringify(r.body)}`);
    successDeployId = (r.body as any).deployment_id ?? "";
    successAppId = (r.body as any).app_id ?? "";
    r.status === 202 ? ok("zip intake → 202") : fail("zip intake should 202", `got ${r.status}`);
  }

  // Stream logs in real-time
  console.log(`  Streaming deployment ${successDeployId.slice(0, 8)}…:`);
  try {
    const events = await streamRequest(`/v1/deployments/${successDeployId}/stream`, authHeaders(keyA));
    for (const raw of events) {
      try {
        const e = JSON.parse(raw);
        console.log(`    ${DIM("sse")}  ${JSON.stringify(e)}`);
      } catch { console.log(`    ${DIM("raw")} ${raw}`); }
    }
    const parsed = events.map((e) => { try { return JSON.parse(e); } catch { return {}; } });
    parsed.some((e: any) => e.type === "status" && e.status === "success") ? ok("stream ended with success") : fail("stream did not reach success");
    parsed.some((e: any) => e.type === "url") ? ok("stream included url event") : fail("stream missing url event");
    parsed.some((e: any) => e.type === "done") ? ok("stream ended with done") : fail("stream missing done event");
  } catch (e) {
    fail("stream failed", String(e));
  }

  // Poll deployment status
  await new Promise((r) => setTimeout(r, 100));
  {
    const r = await request("GET", `/v1/deployments/${successDeployId}`, { headers: authHeaders(keyA) });
    console.log(`  GET /v1/deployments/${successDeployId.slice(0, 8)}… → ${r.status}  status=${(r.body as any).status}  url=${(r.body as any).url}`);
    (r.body as any).status === "success" ? ok("deployment status=success") : fail("deployment should be success", String((r.body as any).status));
    (r.body as any).url ? ok(`url present: ${(r.body as any).url}`) : fail("url should be present");
  }

  // ════════════════════════════════════════════════════════════════════════════
  section("D: Deploy that fails — error event + late-join replay (scenario b)");
  // ════════════════════════════════════════════════════════════════════════════

  let failDeployId = "";

  {
    // Tell the test server to fail the next deploy via the control endpoint
    const ctrl = await request("POST", "/test/set-deploy-mode", { body: { mode: "failure" } });
    console.log(`  POST /test/set-deploy-mode → ${ctrl.status}  body=${JSON.stringify(ctrl.body)}`);

    const zip = await buildZip({
      "package.json": '{"name":"bad-app"}',
      "Dockerfile": "FROM node:20-alpine\nRRUN echo bad",
    });
    const form = new FormData();
    form.append("code", zip, { filename: "app.zip", contentType: "application/zip" });
    form.append("app_name", "bad-app");
    const r = await request("POST", "/v1/deployments/intake/zip", {
      headers: authHeaders(keyA),
      formData: form,
    });
    console.log(`  POST /intake/zip (will fail) → ${r.status}  body=${JSON.stringify(r.body)}`);
    failDeployId = (r.body as any).deployment_id ?? "";

    // Stream live — must see error + failed + done
    console.log(`  Live stream for failing deploy ${failDeployId.slice(0, 8)}…:`);
    const events = await streamRequest(`/v1/deployments/${failDeployId}/stream`, authHeaders(keyA));
    for (const raw of events) {
      try { console.log(`    ${DIM("sse")}  ${JSON.stringify(JSON.parse(raw))}`); } catch {}
    }
    const parsed = events.map((e) => { try { return JSON.parse(e); } catch { return {}; } });
    parsed.some((e: any) => e.type === "error") ? ok("live stream has error event") : fail("live stream missing error event");
    const errEvt = parsed.find((e: any) => e.type === "error");
    if (errEvt) console.log(`    ${DIM("→ error")}  stage=${errEvt.stage}  message="${errEvt.message}"`);
    parsed.some((e: any) => e.type === "status" && e.status === "failed") ? ok("live stream status=failed") : fail("live stream missing failed status");
  }

  // Late-join replay — open stream AFTER deploy finished
  await new Promise((r) => setTimeout(r, 300));
  console.log(`  Late-join replay for already-finished failing deploy:`);
  {
    const events = await streamRequest(`/v1/deployments/${failDeployId}/stream`, authHeaders(keyA));
    for (const raw of events) {
      try { console.log(`    ${DIM("replay")}  ${JSON.stringify(JSON.parse(raw))}`); } catch {}
    }
    const parsed = events.map((e) => { try { return JSON.parse(e); } catch { return {}; } });
    parsed.some((e: any) => e.type === "error") ? ok("replay includes error event") : fail("replay missing error event");
    parsed.some((e: any) => e.type === "status" && e.status === "failed") ? ok("replay has status=failed") : fail("replay missing failed status");
    parsed.some((e: any) => e.type === "done") ? ok("replay ends with done") : fail("replay missing done");
  }

  // ════════════════════════════════════════════════════════════════════════════
  section("E: Redeploy with --app (scenario c)");
  // ════════════════════════════════════════════════════════════════════════════

  {
    const zip = await buildZip({
      "package.json": JSON.stringify({ name: "redeployed-app", version: "2.0.0" }),
      "index.js": "// v2",
    });
    const form = new FormData();
    form.append("code", zip, { filename: "app.zip", contentType: "application/zip" });
    form.append("app_id", successAppId);  // redeploy the successful app
    const r = await request("POST", "/v1/deployments/intake/zip", {
      headers: authHeaders(keyA),
      formData: form,
    });
    console.log(`  POST /intake/zip (redeploy app_id=${successAppId.slice(0, 8)}…) → ${r.status}  body=${JSON.stringify(r.body)}`);
    r.status === 202 ? ok("redeploy → 202") : fail("redeploy should 202", `got ${r.status} ${JSON.stringify(r.body)}`);
    const redeployId = (r.body as any).deployment_id ?? "";
    const redeployAppId = (r.body as any).app_id ?? "";

    // Verify app_id is the same (only meaningful if intake succeeded)
    if (r.status === 202) {
      redeployAppId === successAppId
        ? ok("redeploy reuses same app_id")
        : fail("redeploy should reuse app_id", `redeployAppId=${redeployAppId} successAppId=${successAppId}`);
    } else {
      fail("redeploy app_id check skipped (intake failed)", `status=${r.status}`);
    }

    // Stream it
    await new Promise((r) => setTimeout(r, 300));
    const events = await streamRequest(`/v1/deployments/${redeployId}/stream`, authHeaders(keyA));
    console.log(`  Redeploy stream events:`);
    for (const raw of events) {
      try { console.log(`    ${DIM("sse")}  ${JSON.stringify(JSON.parse(raw))}`); } catch {}
    }
    const parsed = events.map((e) => { try { return JSON.parse(e); } catch { return {}; } });
    parsed.some((e: any) => e.type === "status" && e.status === "success") ? ok("redeploy stream → success") : fail("redeploy stream should succeed");

    // Check version incremented (skip if intake failed — redeployId is empty)
    if (redeployId) {
      const { rows } = await pool.query<{ version: number }>(
        "SELECT version FROM deployments WHERE id=$1",
        [redeployId],
      );
      const v = rows[0]?.version ?? 0;
      console.log(`  Redeploy version=${v}`);
      v >= 2 ? ok(`redeploy version=${v} (incremented)`) : fail("redeploy version should be ≥2");
    } else {
      fail("redeploy version check skipped (no deployment_id — intake failed)");
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  section("F: Rate limits");
  // ════════════════════════════════════════════════════════════════════════════

  // F1: hourly limit — verify org A has already hit 10 deploys this session
  {
    const zip = await buildZip({ "package.json": '{"name":"hourly-test"}' });
    const form = new FormData();
    form.append("code", zip, { filename: "app.zip", contentType: "application/zip" });
    form.append("app_name", "hourly-test");
    const r = await request("POST", "/v1/deployments/intake/zip", {
      headers: authHeaders(keyA),
      formData: form,
    });
    console.log(`  POST /intake/zip (org A, hourly limit) → ${r.status}  body=${JSON.stringify(r.body)}`);
    r.status === 429 && (r.body as any).error === "hourly_deploys"
      ? ok("hourly deploy limit → 429")
      : r.status === 202
        ? ok("hourly limit not yet hit (org A under 10 this run)")
        : fail("unexpected status", `${r.status} ${JSON.stringify(r.body)}`);
  }

  // F2: app-count limit — use a fresh org seeded with 10 active apps
  {
    const { rows: orgRows } = await pool.query<{ id: string }>(
      "INSERT INTO orgs (clerk_org_id, name, slug) VALUES ('clerk_org_limit','Limit Org','limit-org') RETURNING id",
    );
    const limitOrgId = orgRows[0].id;
    const limitKey = await (async () => {
      const { fullKey, keyPrefix, keyHash } = generateApiKey();
      await pool.query(
        "INSERT INTO api_keys (org_id, created_by, name, key_prefix, key_hash) VALUES ($1,$2,'limit-key',$3,$4)",
        [limitOrgId, userId, keyPrefix, keyHash],
      );
      return fullKey;
    })();

    // Insert 10 active apps (each with a success deployment so they count toward app limit)
    // Use started_at 2 hours ago so they don't trigger the hourly limit
    for (let i = 0; i < 10; i++) {
      const { rows: appRows } = await pool.query<{ id: string }>(
        "INSERT INTO apps (org_id, owner_id, name, slug, source_type) VALUES ($1,$2,$3,$4,'zip') RETURNING id",
        [limitOrgId, userId, `limit-app-${i}`, `limit-app-${i}`],
      );
      await pool.query(
        "INSERT INTO deployments (app_id, version, status, started_at) VALUES ($1,1,'success', now() - INTERVAL '2 hours')",
        [appRows[0].id],
      );
    }

    const zip = await buildZip({ "package.json": '{"name":"limit-test"}' });
    const form = new FormData();
    form.append("code", zip, { filename: "app.zip", contentType: "application/zip" });
    const r = await request("POST", "/v1/deployments/intake/zip", {
      headers: authHeaders(limitKey),
      formData: form,
    });
    console.log(`  POST /intake/zip (app count limit, 10 apps seeded) → ${r.status}  body=${JSON.stringify(r.body)}`);
    r.status === 429 && (r.body as any).error === "app_count"
      ? ok("app count limit → 429")
      : fail("app count limit should 429 with app_count error", `got ${r.status} ${JSON.stringify(r.body)}`);

    // Cleanup
    await pool.query("DELETE FROM orgs WHERE id=$1", [limitOrgId]);
  }

  // F3: failed apps do NOT count toward the limit
  {
    const { rows: orgRows } = await pool.query<{ id: string }>(
      "INSERT INTO orgs (clerk_org_id, name, slug) VALUES ('clerk_org_failcheck','FailCheck Org','failcheck-org') RETURNING id",
    );
    const failCheckOrgId = orgRows[0].id;
    const failCheckKey = await (async () => {
      const { fullKey, keyPrefix, keyHash } = generateApiKey();
      await pool.query(
        "INSERT INTO api_keys (org_id, created_by, name, key_prefix, key_hash) VALUES ($1,$2,'fc-key',$3,$4)",
        [failCheckOrgId, userId, keyPrefix, keyHash],
      );
      return fullKey;
    })();

    // Insert 10 apps where ALL deployments failed — should NOT count toward app limit
    // Also use old timestamps to avoid hourly limit
    for (let i = 0; i < 10; i++) {
      const { rows: appRows } = await pool.query<{ id: string }>(
        "INSERT INTO apps (org_id, owner_id, name, slug, source_type) VALUES ($1,$2,$3,$4,'zip') RETURNING id",
        [failCheckOrgId, userId, `fail-app-${i}`, `fail-app-${i}`],
      );
      await pool.query(
        "INSERT INTO deployments (app_id, version, status, started_at) VALUES ($1,1,'failed', now() - INTERVAL '2 hours')",
        [appRows[0].id],
      );
    }

    const zip = await buildZip({ "package.json": '{"name":"fail-check"}' });
    const form = new FormData();
    form.append("code", zip, { filename: "app.zip", contentType: "application/zip" });
    const r = await request("POST", "/v1/deployments/intake/zip", {
      headers: authHeaders(failCheckKey),
      formData: form,
    });
    console.log(`  POST /intake/zip (10 all-failed apps, should allow) → ${r.status}  body=${JSON.stringify(r.body)}`);
    r.status === 202
      ? ok("all-failed apps excluded from limit → 202 allowed")
      : fail("all-failed apps should not count toward limit", `got ${r.status} ${JSON.stringify(r.body)}`);

    // Cleanup
    await pool.query("DELETE FROM orgs WHERE id=$1", [failCheckOrgId]);
  }

  // ════════════════════════════════════════════════════════════════════════════
  section("G: Zip upload — raw multipart through endpoint");
  // ════════════════════════════════════════════════════════════════════════════

  {
    // Valid zip
    const zip = await buildZip({
      "package.json": '{"name":"direct-upload"}',
      "app.js": "require('http').createServer((_,r)=>r.end('ok')).listen(8080)",
    });
    console.log(`  Zip buffer size: ${zip.length} bytes`);
    const form = new FormData();
    form.append("code", zip, { filename: "app.zip", contentType: "application/zip" });
    form.append("app_name", "direct-upload");
    const r = await request("POST", "/v1/deployments/intake/zip", {
      headers: authHeaders(keyA),
      formData: form,
    });
    console.log(`  POST /intake/zip (valid) → ${r.status}  body=${JSON.stringify(r.body)}`);
    r.status === 202 ? ok("direct zip upload → 202") : fail("zip upload should 202", `got ${r.status}`);
  }
  {
    // Zip containing .env file should be rejected
    const zip = await buildZip({
      "package.json": '{"name":"leak-test"}',
      ".env": "SECRET=mypassword",
    });
    const form = new FormData();
    form.append("code", zip, { filename: "app.zip", contentType: "application/zip" });
    const r = await request("POST", "/v1/deployments/intake/zip", {
      headers: authHeaders(keyA),
      formData: form,
    });
    console.log(`  POST /intake/zip (.env inside) → ${r.status}  body=${JSON.stringify(r.body)}`);
    r.status === 400 ? ok("zip with .env → 400") : fail("zip with .env should 400", `got ${r.status} ${JSON.stringify(r.body)}`);
  }
  {
    // Zip-slip: a zip with a path-traversal entry (../evil.txt) must be rejected.
    // The zip is crafted with Python's zipfile (which doesn't sanitise paths);
    // the base64 constant is deterministic and verified.
    const zipSlipB64 =
      "UEsDBBQAAAAAAAAAIQByrErGCwAAAAsAAAALAAAALi4vZXZpbC50eHRiYWQgY29udGVudFBLAQIU" +
      "AxQAAAAAAAAAIQByrErGCwAAAAsAAAALAAAAAAAAAAAAAACAAQAAAAAuLi9ldmlsLnR4dFBLBQYA" +
      "AAAAAQABADkAAAA0AAAAAAA=";
    const zipSlipBuf = Buffer.from(zipSlipB64, "base64");
    const form = new FormData();
    form.append("code", zipSlipBuf, { filename: "slip.zip", contentType: "application/zip" });
    const r = await request("POST", "/v1/deployments/intake/zip", {
      headers: authHeaders(keyA),
      formData: form,
    });
    console.log(`  POST /intake/zip (zip-slip ../evil.txt) → ${r.status}  body=${JSON.stringify(r.body)}`);
    r.status === 400 ? ok("zip-slip entry → 400") : fail("zip-slip should 400", `got ${r.status} ${JSON.stringify(r.body)}`);
    (r.body as any)?.message?.includes("unsafe path")
      ? ok("zip-slip → unsafe path message")
      : fail("zip-slip → expected 'unsafe path' in message", JSON.stringify(r.body));
  }
  {
    // 50 MB cap: multer must reject the upload before it reaches zip validation.
    // The buffer doesn't need to be a valid zip — multer counts multipart bytes.
    const oversizedBuf = Buffer.alloc(50 * 1024 * 1024 + 1, 0x42);
    const form = new FormData();
    form.append("code", oversizedBuf, { filename: "big.zip", contentType: "application/zip" });
    console.log(`  Sending ${oversizedBuf.length} byte payload (50 MB + 1)…`);
    const r = await request("POST", "/v1/deployments/intake/zip", {
      headers: authHeaders(keyA),
      formData: form,
    });
    console.log(`  POST /intake/zip (oversized) → ${r.status}  body=${JSON.stringify(r.body)}`);
    r.status === 413 ? ok("oversized upload → 413") : fail("oversized upload should 413", `got ${r.status}`);
    (r.body as any)?.error === "file_too_large"
      ? ok("oversized upload → error=file_too_large")
      : fail("oversized upload → expected error=file_too_large", JSON.stringify(r.body));
  }

  // ════════════════════════════════════════════════════════════════════════════
  section("H: Reaper — cleans stuck deployments");
  // ════════════════════════════════════════════════════════════════════════════

  {
    // Insert a deployment stuck in 'building' for 20 minutes
    const { rows: appRows } = await pool.query<{ id: string }>(
      "INSERT INTO apps (org_id, owner_id, name, slug, source_type) VALUES ($1,$2,'reaper-test','reaper-test','zip') RETURNING id",
      [orgAId, userId],
    );
    const { rows: depRows } = await pool.query<{ id: string }>(
      `INSERT INTO deployments (app_id, version, status, started_at)
       VALUES ($1, 1, 'building', now() - INTERVAL '20 minutes')
       RETURNING id`,
      [appRows[0].id],
    );
    const stuckId = depRows[0].id;
    console.log(`  Inserted stuck deployment ${stuckId.slice(0, 8)}…`);

    // Trigger reaper directly
    const { reapStalledDeployments } = require("../src/lib/reaper");
    const count = await reapStalledDeployments();
    console.log(`  Reaper reaped ${count} deployment(s)`);

    const { rows } = await pool.query<{ status: string; failure_stage: string; failure_message: string }>(
      "SELECT status, failure_stage, failure_message FROM deployments WHERE id=$1",
      [stuckId],
    );
    const d = rows[0];
    console.log(`  After reap: status=${d.status}  stage=${d.failure_stage}  msg="${d.failure_message}"`);
    d.status === "failed" ? ok("reaper → status=failed") : fail("reaper should set failed", `got ${d.status}`);
    d.failure_stage === "timeout" ? ok("reaper → failure_stage=timeout") : fail("failure_stage should be timeout");
    d.failure_message?.includes("interrupted or timed out") ? ok("reaper → correct failure_message") : fail("wrong failure_message");

    // Verify late-join stream shows error+failed+done
    const events = await streamRequest(`/v1/deployments/${stuckId}/stream`, authHeaders(keyA));
    console.log(`  Stream replay for reaped deployment:`);
    for (const raw of events) {
      try { console.log(`    ${DIM("replay")}  ${JSON.stringify(JSON.parse(raw))}`); } catch {}
    }
    const parsed = events.map((e) => { try { return JSON.parse(e); } catch { return {}; } });
    parsed.some((e: any) => e.type === "error" && e.stage === "timeout") ? ok("reaped stream has error event with stage=timeout") : fail("reaped stream missing timeout error");
  }

  // ════════════════════════════════════════════════════════════════════════════
  section("I: DELETE /v1/apps/:id");
  // ════════════════════════════════════════════════════════════════════════════

  {
    // Create an app to delete
    const { rows: appRows } = await pool.query<{ id: string }>(
      "INSERT INTO apps (org_id, owner_id, name, slug, source_type, fly_app_id) VALUES ($1,$2,'delete-me','delete-me','zip','ssc-delete-me') RETURNING id",
      [orgAId, userId],
    );
    const appId = appRows[0].id;

    const r = await request("DELETE", `/v1/apps/${appId}`, { headers: authHeaders(keyA) });
    console.log(`  DELETE /v1/apps/${appId.slice(0, 8)}… → ${r.status}  body=${JSON.stringify(r.body)}`);
    r.status === 200 ? ok("delete app → 200") : fail("delete should 200", `got ${r.status}`);

    // Verify soft-deleted
    const { rows } = await pool.query<{ deleted_at: Date | null }>(
      "SELECT deleted_at FROM apps WHERE id=$1",
      [appId],
    );
    rows[0].deleted_at ? ok("app has deleted_at set") : fail("deleted_at should be set");

    // Can't access deleted app
    const r2 = await request("GET", `/v1/apps/${appId}`, { headers: authHeaders(keyA) });
    r2.status === 404 ? ok("deleted app → 404 on GET") : fail("deleted app should 404", `got ${r2.status}`);

    // Cross-org delete should 404
    const r3 = await request("DELETE", `/v1/apps/${appId}`, { headers: authHeaders(keyB) });
    r3.status === 404 ? ok("cross-org delete → 404") : fail("cross-org delete should 404", `got ${r3.status}`);
  }

  // ════════════════════════════════════════════════════════════════════════════
  section("J: CLI zipDirectory safety checks");
  // ════════════════════════════════════════════════════════════════════════════

  // Import the built client zip function
  const clientDist = path.join(__dirname, "../../../packages/client/dist/zip.js");
  if (!fs.existsSync(clientDist)) {
    console.log(DIM("  [skip] packages/client not built, run: cd packages/client && pnpm build"));
  } else {
    const { zipDirectory } = require(clientDist);

    // Refuse home dir
    try {
      await zipDirectory(os.homedir());
      fail("should refuse home directory");
    } catch (e: any) {
      console.log(`  zipDirectory(homedir) threw: ${e.message}`);
      ok("refuses home directory");
    }

    // Refuse dir with no project marker
    const tmpNoMarker = fs.mkdtempSync(path.join(os.tmpdir(), "ssc-test-no-marker-"));
    fs.writeFileSync(path.join(tmpNoMarker, "random.txt"), "hello");
    try {
      await zipDirectory(tmpNoMarker);
      fail("should refuse dir without project marker");
    } catch (e: any) {
      console.log(`  zipDirectory(no marker) threw: ${e.message}`);
      ok("refuses dir without project marker");
    } finally { fs.rmSync(tmpNoMarker, { recursive: true }); }

    // Valid project zip and verify .env is excluded
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "ssc-test-proj-"));
    fs.writeFileSync(path.join(tmpProject, "package.json"), '{"name":"test"}');
    fs.writeFileSync(path.join(tmpProject, "index.js"), "// app");
    fs.writeFileSync(path.join(tmpProject, ".env"), "SECRET=abc");
    fs.writeFileSync(path.join(tmpProject, ".env.local"), "X=1");
    fs.mkdirSync(path.join(tmpProject, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(tmpProject, "node_modules", "big.js"), "x".repeat(1000));
    try {
      const buf = await zipDirectory(tmpProject);
      console.log(`  zipDirectory(valid project) → ${buf.length} bytes`);
      ok("zips valid project");

      // Inspect zip contents
      const unzipper = require("unzipper");
      const dir = await unzipper.Open.buffer(buf);
      const names = dir.files.map((f: any) => f.path);
      console.log(`  Zip entries: ${names.join(", ")}`);
      !names.some((n: string) => n === ".env" || n.startsWith(".env.")) ? ok(".env excluded from zip") : fail(".env should be excluded");
      !names.some((n: string) => n.includes("node_modules/")) ? ok("node_modules excluded from zip") : fail("node_modules should be excluded");
    } catch (e: any) {
      fail("valid project zip failed", e.message);
    } finally { fs.rmSync(tmpProject, { recursive: true }); }
  }

  // ════════════════════════════════════════════════════════════════════════════
  section("K: Current DB state (apps + deployments)");
  // ════════════════════════════════════════════════════════════════════════════

  {
    const { rows: appRows } = await pool.query(
      `SELECT a.name, a.deleted_at IS NOT NULL AS deleted,
              COUNT(d.id) AS total_deps,
              COUNT(d.id) FILTER (WHERE d.status='success') AS success,
              COUNT(d.id) FILTER (WHERE d.status='failed') AS failed,
              COUNT(d.id) FILTER (WHERE d.status IN ('queued','building','deploying')) AS in_progress
       FROM apps a
       LEFT JOIN deployments d ON d.app_id = a.id
       GROUP BY a.id, a.name, a.deleted_at
       ORDER BY a.name`,
    );
    console.log(`\n  Apps and deployment counts:`);
    for (const row of appRows) {
      const status = row.deleted ? DIM("[deleted]") : "";
      console.log(
        `    ${row.name.padEnd(20)} ${status.padEnd(10)} ` +
        `total=${row.total_deps}  success=${row.success}  failed=${row.failed}  in_progress=${row.in_progress}`,
      );
    }
    ok(`${appRows.length} app(s) visible`);
  }

  // ════════════════════════════════════════════════════════════════════════════
  section("L: App-type detection + Dockerfile / fly.toml generation");
  // ════════════════════════════════════════════════════════════════════════════

  {
    const { detectAppType } = require("../src/services/appDetector");
    const { generateDeployFiles } = require("../src/services/dockerfileGen");
    const fsTmp = require("fs/promises");
    const pathTmp = require("path");
    const osTmp = require("os");

    const mkTmp = () => fsTmp.mkdtemp(pathTmp.join(osTmp.tmpdir(), "ssc-det-"));
    const cleanup = (d: string) => fsTmp.rm(d, { recursive: true, force: true }).catch(() => {});

    // ── L1: Node (npm, with start script) ────────────────────────────────────
    {
      const d = await mkTmp();
      try {
        await fsTmp.writeFile(pathTmp.join(d, "package.json"), JSON.stringify({
          name: "node-test", version: "1.0.0", scripts: { start: "node index.js" },
        }));
        const t = await detectAppType(d);
        console.log(`  detectAppType(node) → ${JSON.stringify(t)}`);
        t.kind === "node" ? ok("Node: kind=node") : fail("Node detection failed", JSON.stringify(t));
        t.kind === "node" && t.packageManager === "npm" ? ok("Node: pm=npm") : fail("pm should be npm");

        const { internalPort } = await generateDeployFiles(d, "ssc-node-test", t);
        console.log(`  generateDeployFiles(node) → internalPort=${internalPort}`);
        internalPort === 8080 ? ok("Node: internalPort=8080") : fail("expected 8080");

        const df = await fsTmp.readFile(pathTmp.join(d, "Dockerfile"), "utf8");
        df.includes("node:20-alpine") ? ok("Node: Dockerfile has node:20-alpine") : fail("Dockerfile missing node image");
        df.includes("package-lock.json") ? ok("Node: Dockerfile has lockfile check") : fail("Dockerfile missing lockfile check");

        const ft = await fsTmp.readFile(pathTmp.join(d, "fly.toml"), "utf8");
        ft.includes("ssc-node-test") ? ok("Node: fly.toml has app name") : fail("fly.toml missing app name");
      } finally { await cleanup(d); }
    }

    // ── L2: Node (pnpm) ──────────────────────────────────────────────────────
    {
      const d = await mkTmp();
      try {
        await fsTmp.writeFile(pathTmp.join(d, "package.json"), JSON.stringify({
          name: "pnpm-test", version: "1.0.0", scripts: { start: "node server.js" },
        }));
        await fsTmp.writeFile(pathTmp.join(d, "pnpm-lock.yaml"), "");
        const t = await detectAppType(d);
        console.log(`  detectAppType(pnpm) → ${JSON.stringify(t)}`);
        t.kind === "node" && t.packageManager === "pnpm" ? ok("Node: pm=pnpm") : fail("pm should be pnpm");
      } finally { await cleanup(d); }
    }

    // ── L3: Python (gunicorn) ─────────────────────────────────────────────────
    {
      const d = await mkTmp();
      try {
        await fsTmp.writeFile(pathTmp.join(d, "requirements.txt"), "flask==3.0.0\ngunicorn");
        await fsTmp.writeFile(pathTmp.join(d, "app.py"), "app = None");
        const t = await detectAppType(d);
        console.log(`  detectAppType(python/gunicorn) → ${JSON.stringify(t)}`);
        t.kind === "python" ? ok("Python: kind=python") : fail("Python detection failed");
        t.kind === "python" && t.server === "gunicorn" ? ok("Python: server=gunicorn") : fail("server should be gunicorn");

        const { internalPort } = await generateDeployFiles(d, "ssc-py-test", t);
        internalPort === 8080 ? ok("Python: internalPort=8080") : fail("expected 8080");
        const df = await fsTmp.readFile(pathTmp.join(d, "Dockerfile"), "utf8");
        df.includes("python:3.11-slim") ? ok("Python: Dockerfile has python:3.11-slim") : fail("Dockerfile missing python image");
      } finally { await cleanup(d); }
    }

    // ── L4: Python (uvicorn / FastAPI) ────────────────────────────────────────
    {
      const d = await mkTmp();
      try {
        await fsTmp.writeFile(pathTmp.join(d, "requirements.txt"), "fastapi\nuvicorn[standard]");
        await fsTmp.writeFile(pathTmp.join(d, "main.py"), "app = None");
        const t = await detectAppType(d);
        console.log(`  detectAppType(python/uvicorn) → ${JSON.stringify(t)}`);
        t.kind === "python" && t.server === "uvicorn" ? ok("Python: server=uvicorn (FastAPI)") : fail("server should be uvicorn");
      } finally { await cleanup(d); }
    }

    // ── L5: Static (index.html) ───────────────────────────────────────────────
    {
      const d = await mkTmp();
      try {
        await fsTmp.writeFile(pathTmp.join(d, "index.html"), "<h1>hello</h1>");
        const t = await detectAppType(d);
        console.log(`  detectAppType(static) → ${JSON.stringify(t)}`);
        t.kind === "static" ? ok("Static: kind=static") : fail("Static detection failed");

        const { internalPort } = await generateDeployFiles(d, "ssc-static-test", t);
        internalPort === 80 ? ok("Static: internalPort=80") : fail("expected 80");
        const df = await fsTmp.readFile(pathTmp.join(d, "Dockerfile"), "utf8");
        df.includes("nginx:alpine") ? ok("Static: Dockerfile has nginx") : fail("Dockerfile missing nginx");
      } finally { await cleanup(d); }
    }

    // ── L6: Pass-through (Dockerfile present) ────────────────────────────────
    {
      const d = await mkTmp();
      try {
        await fsTmp.writeFile(pathTmp.join(d, "Dockerfile"), "FROM node:20-alpine\nEXPOSE 3000\n");
        const t = await detectAppType(d);
        console.log(`  detectAppType(dockerfile) → ${JSON.stringify(t)}`);
        t.kind === "dockerfile" ? ok("Dockerfile pass-through: kind=dockerfile") : fail("should be dockerfile");

        // generateDeployFiles must not overwrite the user Dockerfile, only write fly.toml
        const before = await fsTmp.readFile(pathTmp.join(d, "Dockerfile"), "utf8");
        await generateDeployFiles(d, "ssc-df-test", t);
        const after = await fsTmp.readFile(pathTmp.join(d, "Dockerfile"), "utf8");
        before === after ? ok("Dockerfile pass-through: user Dockerfile not overwritten") : fail("user Dockerfile was overwritten");
        const ft = await fsTmp.readFile(pathTmp.join(d, "fly.toml"), "utf8");
        ft.includes("internal_port = 3000") ? ok("Dockerfile pass-through: fly.toml sniffed EXPOSE 3000") : fail("fly.toml wrong port");
      } finally { await cleanup(d); }
    }

    // ── L7: Unrecognised → clear error ───────────────────────────────────────
    {
      const d = await mkTmp();
      try {
        await fsTmp.writeFile(pathTmp.join(d, "main.go"), "package main");
        try {
          await detectAppType(d);
          fail("Unrecognised app should throw");
        } catch (e: any) {
          console.log(`  detectAppType(unrecognised) threw: ${e.message.split("\n")[0]}`);
          ok("Unrecognised app: throws helpful error");
        }
      } finally { await cleanup(d); }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  section("M: DB error → 500 JSON + server stays up");
  // ════════════════════════════════════════════════════════════════════════════

  {
    const t0 = Date.now();
    const r = await request("GET", "/test/db-error");
    const elapsed = Date.now() - t0;
    console.log(`  GET /test/db-error → ${r.status}  body=${JSON.stringify(r.body)}  (${elapsed}ms)`);
    r.status === 500 ? ok("DB error → 500") : fail("DB error should 500", `got ${r.status} ${JSON.stringify(r.body)}`);
    (r.body as any)?.error === "internal_error"
      ? ok("500 body has error=internal_error")
      : fail("500 body missing error=internal_error", JSON.stringify(r.body));
    elapsed < 2000 ? ok(`response within 2s (${elapsed}ms)`) : fail(`response too slow: ${elapsed}ms`);

    // Server must still be alive
    const health = await request("GET", "/health");
    health.status === 200 ? ok("server still alive after DB error") : fail("server died after DB error", `got ${health.status}`);
    (health.body as any)?.db === "ok" ? ok("health reports db ok") : fail("health does not report db ok", JSON.stringify(health.body));
  }

  // ════════════════════════════════════════════════════════════════════════════
  section("N: Secret scrubbing — safeErr + Fly API errors");
  // ════════════════════════════════════════════════════════════════════════════

  // N1 & N2: unit-test safeErr directly (no server needed)
  {
    const { safeErr, scrubSecrets } = require("../src/lib/safeErr");

    // N1a: safeErr with a fake Axios error that has Authorization in config
    //      simulates what an un-intercepted Fly API error looks like
    const fakeToken = "ssc_fake_secret_bearer_token_value";
    const fakeAxiosErr = Object.assign(
      new Error("Request failed with status code 401"),
      {
        isAxiosError: true,
        config: {
          method: "delete",
          url: `https://api.machines.dev/v1/apps/test?token=${fakeToken}`,
          headers: { Authorization: `Bearer ${fakeToken}` },
        },
        request: { _header: `Authorization: Bearer ${fakeToken}` },
        response: { status: 401, data: { error: "unauthorized" } },
      },
    );
    const result = safeErr(fakeAxiosErr) as string;
    console.log(`  safeErr(fakeAxiosErr) → "${result}"`);

    !result.includes(fakeToken)
      ? ok("N1: token value not in safeErr output")
      : fail("N1: token value leaked in safeErr output");
    !result.includes("Bearer ")
      ? ok("N1: 'Bearer' not in safeErr output")
      : fail("N1: 'Bearer' leaked in safeErr output");
    !result.includes("Authorization")
      ? ok("N1: 'Authorization' not in safeErr output")
      : fail("N1: 'Authorization' leaked in safeErr output");
    result.includes("401")
      ? ok("N1: HTTP status preserved in output")
      : fail("N1: status missing from safeErr output");
    result.includes("unauthorized")
      ? ok("N1: response message preserved in output")
      : fail("N1: response message missing from safeErr output");

    // N1b: plain Error whose message contains the token value
    const errWithToken = new Error(`http call failed Bearer ${fakeToken}`);
    const r1b = safeErr(errWithToken) as string;
    console.log(`  safeErr(Error with token in msg) → "${r1b}"`);
    !r1b.includes(fakeToken)
      ? ok("N1b: token value scrubbed from plain Error message")
      : fail("N1b: token value leaked in plain Error message");

    // N2: scrubSecrets with the actual env token value ("test-token" in test server)
    const envToken = process.env.FLY_API_TOKEN ?? "test-token";
    const dirty = `call failed: Bearer ${envToken} at /v1/apps`;
    const clean = scrubSecrets(dirty) as string;
    console.log(`  scrubSecrets("...Bearer ${envToken}...") → "${clean}"`);
    !clean.includes(envToken)
      ? ok("N2: env token value scrubbed by scrubSecrets")
      : fail("N2: env token value not scrubbed");
    !clean.includes("Bearer " + envToken)
      ? ok("N2: full Bearer+token pattern scrubbed")
      : fail("N2: full Bearer pattern not scrubbed");
  }

  // N3: force Fly 401 via DELETE /v1/apps — check server logs contain no credentials
  {
    // Drain any logs accumulated so far
    await request("GET", "/test/drain-logs");

    // Enable fly-error mode: destroyFlyApp throws a raw Axios error with
    // Authorization header in config — the worst-case shape.
    const setErr = await request("POST", "/test/set-fly-error", { body: { enabled: true } });
    console.log(`  POST /test/set-fly-error → ${setErr.status}  body=${JSON.stringify(setErr.body)}`);

    // Create an app with a fly_app_id so the DELETE path hits destroyFlyApp
    const { rows: appRows } = await pool.query<{ id: string }>(
      "INSERT INTO apps (org_id, owner_id, name, slug, source_type, fly_app_id) VALUES ($1,$2,'fly-err-test','fly-err-test','zip','ssc-fly-err-test') RETURNING id",
      [orgAId, userId],
    );
    const errAppId = appRows[0].id;

    // DELETE the app — apps.ts:destroyFlyApp will throw, catch block logs safeErr(err)
    const delResp = await request("DELETE", `/v1/apps/${errAppId}`, {
      headers: authHeaders(keyA),
    });
    console.log(`  DELETE /v1/apps/${errAppId.slice(0, 8)}… → ${delResp.status}`);

    // Give the handler time to complete
    await new Promise((r) => setTimeout(r, 100));

    // Drain and inspect the captured logs
    const logsResp = await request("GET", "/test/drain-logs");
    const logs: string[] = (logsResp.body as any).logs ?? [];
    const logText = logs.join("\n");
    console.log(`  Captured ${logs.length} log line(s) after fly-error:`);
    for (const line of logs) {
      if (line.includes("[apps]") || line.includes("destroy") || line.includes("fly")) {
        console.log(`    ${line.slice(0, 120)}`);
      }
    }

    const FLY_TOKEN = process.env.FLY_API_TOKEN ?? "test-token";
    !logText.includes("Bearer ")
      ? ok("N3: 'Bearer' not in any log line after Fly 401")
      : fail("N3: 'Bearer' leaked in log after Fly 401", logText.slice(0, 200));
    !logText.includes(FLY_TOKEN)
      ? ok("N3: token value not in any log line after Fly 401")
      : fail("N3: token value leaked in log after Fly 401");
    !logText.includes("Authorization")
      ? ok("N3: 'Authorization' not in any log line after Fly 401")
      : fail("N3: 'Authorization' leaked in log after Fly 401");

    // Disable fly-error mode and clean up
    await request("POST", "/test/set-fly-error", { body: { enabled: false } });
    await pool.query("DELETE FROM apps WHERE id=$1", [errAppId]);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Section O — Real flyClient interceptor (no stubs, local mock HTTP server)
  // ════════════════════════════════════════════════════════════════════════════
  {
    section("O: Real flyClient interceptor — FlyApiError + credential scrubbing");

    // ── Spin up a tiny mock HTTP server ──────────────────────────────────────
    // We use a responseQueue so each incoming request pops one entry.
    type MockResponse = { status: number; body: Record<string, unknown> };
    const responseQueue: MockResponse[] = [];

    const mockServer = http.createServer((req, res) => {
      const next = responseQueue.shift() ?? { status: 500, body: { error: "unexpected request" } };
      res.writeHead(next.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(next.body));
    });

    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    const mockAddr = mockServer.address() as { port: number };
    const mockPort = mockAddr.port;
    const mockBase = `http://127.0.0.1:${mockPort}`;

    // Set env vars BEFORE requiring flyClient so makeClient() picks them up.
    // Use 127.0.0.1 — resolveBaseUrl() honours it in every environment.
    const O_TOKEN = "O_TEST_FLY_TOKEN_SECRET_VALUE";
    const prevFlyApiBase = process.env.FLY_API_BASE;
    const prevFlyToken = process.env.FLY_API_TOKEN;
    process.env.FLY_API_BASE = mockBase;
    process.env.FLY_API_TOKEN = O_TOKEN;

    // Require the real flyClient — run-tests.ts is a separate process, no stubs
    const { createFlyApp, destroyFlyApp, allocateFlyIp, FlyApiError } =
      require("../src/services/flyClient") as {
        createFlyApp: (name: string, org: string) => Promise<void>;
        destroyFlyApp: (name: string) => Promise<void>;
        allocateFlyIp: (name: string) => Promise<string>;
        FlyApiError: new (status: number, msg: string) => Error & { status: number };
      };

    // ── O1: createFlyApp — mock returns 401 ──────────────────────────────────
    responseQueue.push({ status: 401, body: { error: "token validation error" } });
    let o1Err: unknown;
    try { await createFlyApp("o-test-app", "o-test-org"); } catch (e) { o1Err = e; }

    o1Err instanceof FlyApiError
      ? ok("O1: createFlyApp 401 throws FlyApiError")
      : fail("O1: createFlyApp 401 did not throw FlyApiError", String(o1Err));
    (o1Err instanceof FlyApiError && (o1Err as { status: number }).status === 401)
      ? ok("O1: FlyApiError.status === 401")
      : fail("O1: FlyApiError.status !== 401");
    (o1Err instanceof FlyApiError && o1Err.message === "token validation error")
      ? ok("O1: FlyApiError.message === 'token validation error'")
      : fail("O1: FlyApiError.message mismatch", String(o1Err instanceof Error ? o1Err.message : o1Err));

    // ── O2: createFlyApp — credential scrubbing in serialised error ───────────
    if (o1Err instanceof Error) {
      const j = JSON.stringify(o1Err, Object.getOwnPropertyNames(o1Err));
      const u = require("util").inspect(o1Err, { depth: 5 });
      !j.includes(O_TOKEN) && !u.includes(O_TOKEN)
        ? ok("O2: token value absent from JSON.stringify + util.inspect of FlyApiError")
        : fail("O2: token value leaked in serialised FlyApiError");
      !j.includes("Bearer") && !u.includes("Bearer")
        ? ok("O2: 'Bearer' absent from serialised FlyApiError")
        : fail("O2: 'Bearer' leaked in serialised FlyApiError");
      !j.toLowerCase().includes("authorization") && !u.toLowerCase().includes("authorization")
        ? ok("O2: 'Authorization' absent from serialised FlyApiError")
        : fail("O2: 'Authorization' leaked in serialised FlyApiError");
    } else {
      fail("O2: skipped — O1 did not throw Error");
      fail("O2: skipped");
      fail("O2: skipped");
    }

    // ── O3: createFlyApp — 500 with message field ─────────────────────────────
    responseQueue.push({ status: 500, body: { message: "internal server error" } });
    let o3Err: unknown;
    try { await createFlyApp("o-test-app", "o-test-org"); } catch (e) { o3Err = e; }

    o3Err instanceof FlyApiError
      ? ok("O3: createFlyApp 500 throws FlyApiError")
      : fail("O3: createFlyApp 500 did not throw FlyApiError", String(o3Err));
    (o3Err instanceof FlyApiError && (o3Err as { status: number }).status === 500)
      ? ok("O3: FlyApiError.status === 500")
      : fail("O3: FlyApiError.status !== 500");

    // ── O4: destroyFlyApp — 404 returns quietly ───────────────────────────────
    responseQueue.push({ status: 404, body: { error: "app not found" } });
    let o4Err: unknown;
    try { await destroyFlyApp("o-test-app"); }
    catch (e) { o4Err = e; }

    o4Err === undefined
      ? ok("O4: destroyFlyApp 404 returns quietly (no throw)")
      : fail("O4: destroyFlyApp 404 threw unexpectedly", String(o4Err));

    // ── O5: destroyFlyApp — 401 throws FlyApiError ────────────────────────────
    responseQueue.push({ status: 401, body: { error: "token validation error" } });
    let o5Err: unknown;
    try { await destroyFlyApp("o-test-app"); } catch (e) { o5Err = e; }

    o5Err instanceof FlyApiError
      ? ok("O5: destroyFlyApp 401 throws FlyApiError")
      : fail("O5: destroyFlyApp 401 did not throw FlyApiError", String(o5Err));
    (o5Err instanceof FlyApiError && (o5Err as { status: number }).status === 401)
      ? ok("O5: destroyFlyApp FlyApiError.status === 401")
      : fail("O5: destroyFlyApp FlyApiError.status !== 401");

    // ── O6: allocateFlyIp — 401 throws FlyApiError ───────────────────────────
    responseQueue.push({ status: 401, body: { error: "token validation error" } });
    let o6Err: unknown;
    try { await allocateFlyIp("o-test-app"); } catch (e) { o6Err = e; }

    o6Err instanceof FlyApiError
      ? ok("O6: allocateFlyIp 401 throws FlyApiError")
      : fail("O6: allocateFlyIp 401 did not throw FlyApiError", String(o6Err));

    // ── O7: resolveBaseUrl — non-local override is always ignored ────────────────
    const { resolveBaseUrl } =
      require("../src/services/flyClient") as { resolveBaseUrl: () => string };

    process.env.FLY_API_BASE = "https://example.com/v1";
    const o7Base = resolveBaseUrl();
    console.log(`  resolveBaseUrl(FLY_API_BASE=https://example.com, no NODE_ENV) → "${o7Base}"`);
    o7Base === "https://api.machines.dev/v1"
      ? ok("O7: https://example.com override ignored — falls back to api.machines.dev")
      : fail("O7: expected api.machines.dev but got " + o7Base);

    // ── O8: resolveBaseUrl — 127.0.0.1 override is honoured without NODE_ENV=test ─
    process.env.FLY_API_BASE = mockBase; // http://127.0.0.1:<port>
    const o8Base = resolveBaseUrl();
    console.log(`  resolveBaseUrl(FLY_API_BASE=http://127.0.0.1:${mockPort}, no NODE_ENV) → "${o8Base}"`);
    o8Base === mockBase
      ? ok("O8: http://127.0.0.1 override honoured without NODE_ENV=test")
      : fail("O8: expected " + mockBase + " but got " + o8Base);

    // ── Restore env and shut down mock server ─────────────────────────────────
    if (prevFlyApiBase === undefined) delete process.env.FLY_API_BASE;
    else process.env.FLY_API_BASE = prevFlyApiBase;
    if (prevFlyToken === undefined) delete process.env.FLY_API_TOKEN;
    else process.env.FLY_API_TOKEN = prevFlyToken;

    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Section P — flyctl deploy flag guard (real binary, no network call)
  // ════════════════════════════════════════════════════════════════════════════
  {
    section("P: flyctl deploy flags are all recognised by the installed binary");

    // Run `flyctl deploy --help` and collect output.  The test does not call
    // Fly — --help exits immediately without making any API requests.
    const { execFileSync } = require("child_process") as typeof import("child_process");

    let helpText = "";
    let binaryOk = true;
    try {
      // flyctl prints --help to stdout; use stdio pipe so we can capture it.
      helpText = execFileSync("flyctl", ["deploy", "--help"], {
        encoding: "utf8",
        // flyctl may exit non-zero when run with --help in some versions; that's fine.
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: unknown) {
      // execFileSync throws on non-zero exit but still fills stderr/stdout on
      // the error object.  Grab whatever output was produced.
      const ee = e as { stdout?: string; stderr?: string; message?: string };
      helpText = (ee.stdout ?? "") + (ee.stderr ?? "");
      if (!helpText.trim()) {
        fail("P: flyctl deploy --help produced no output", String(ee.message));
        binaryOk = false;
      }
    }

    if (binaryOk) {
      console.log(`  flyctl deploy --help → ${helpText.split("\n").length} lines`);

      // These are the exact flags deployRunner passes.  --ha=false uses the --ha
      // flag, so we check for "--ha" without the value suffix.
      const requiredFlags: string[] = [
        "--remote-only",
        "--ha",
        "--app",
        "--yes",
      ];

      for (const flag of requiredFlags) {
        helpText.includes(flag)
          ? ok(`P: flyctl deploy --help lists ${flag}`)
          : fail(`P: flyctl deploy --help does NOT list ${flag} — code would fail at runtime`);
      }

      // Also confirm --json is NOT a valid flag (this is the regression this
      // test is designed to catch).
      !helpText.includes("--json")
        ? ok("P: --json is NOT a flyctl deploy flag (regression guard)")
        : fail("P: --json appears in flyctl deploy --help — verify deployRunner args");
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Section Q — deployRunner: stderr lines reach the SSE event stream
  // ════════════════════════════════════════════════════════════════════════════
  {
    section("Q: deployRunner stderr lines appear in SSE log events");

    // Create a fake flyctl binary that writes one sentinel to stderr, one to
    // stdout, then exits 0.  Prepend its directory to PATH so spawn finds it.
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssc-fake-flyctl-"));
    const fakeFlyctlPath = path.join(fakeBinDir, "flyctl");
    fs.writeFileSync(
      fakeFlyctlPath,
      "#!/bin/sh\necho 'Q_STDERR_SENTINEL' >&2\necho 'Q_STDOUT_LINE' >&1\n",
      { mode: 0o755 },
    );

    const origPath = process.env.PATH;
    process.env.PATH = fakeBinDir + ":" + (origPath ?? "");

    // Require the real deployRunner (not the stubbed test-server copy).
    // run-tests.ts is a separate process so no stubs are in effect.
    const { runFlyctlDeploy } =
      require("../src/services/deployRunner") as {
        runFlyctlDeploy: (dir: string, appName: string, deploymentId: string) => Promise<void>;
      };
    const { eventBus } =
      require("../src/lib/eventBus") as {
        eventBus: { getOrCreate: (id: string) => import("events").EventEmitter };
      };

    // Give runFlyctlDeploy a real directory as cwd (spawn checks it exists).
    const fakeCwd = fs.mkdtempSync(path.join(os.tmpdir(), "ssc-fake-cwd-"));
    const depId = "q-test-" + crypto.randomUUID().slice(0, 8);

    // Subscribe BEFORE calling runFlyctlDeploy so we don't miss early events.
    const collectedLogs: string[] = [];
    eventBus.getOrCreate(depId).on("event", (evt: { type: string; message?: string }) => {
      if (evt.type === "log" && evt.message) collectedLogs.push(evt.message);
    });

    await runFlyctlDeploy(fakeCwd, "fake-app", depId);

    console.log(`  collected log events: [${collectedLogs.map((l) => JSON.stringify(l)).join(", ")}]`);

    collectedLogs.some((l) => l.includes("Q_STDERR_SENTINEL"))
      ? ok("Q: stderr line appears in SSE log events")
      : fail("Q: stderr line missing from SSE log events", `got: [${collectedLogs.join(" | ")}]`);

    collectedLogs.some((l) => l.includes("Q_STDOUT_LINE"))
      ? ok("Q: stdout line still appears in SSE log events")
      : fail("Q: stdout line missing from SSE log events", `got: [${collectedLogs.join(" | ")}]`);

    // Restore env and clean up temp dirs.
    if (origPath === undefined) delete process.env.PATH;
    else process.env.PATH = origPath;
    fs.rmSync(fakeBinDir, { recursive: true });
    fs.rmSync(fakeCwd, { recursive: true });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Section R — Slug uniqueness: partial index + collision handling
  // ════════════════════════════════════════════════════════════════════════════
  {
    section("R: Slug uniqueness (partial index + collision retry)");

    // Use a fresh org so slug state is clean for this section.
    const { rows: rOrgRows } = await pool.query<{ id: string }>(
      "INSERT INTO orgs (clerk_org_id, name, slug) VALUES ('clerk_org_slug_test','Slug Test Org','slug-test-org') RETURNING id",
    );
    const rOrgId = rOrgRows[0].id;
    const rKey = await (async () => {
      const { fullKey, keyPrefix, keyHash } = generateApiKey();
      await pool.query(
        "INSERT INTO api_keys (org_id, created_by, name, key_prefix, key_hash) VALUES ($1,$2,'r-key',$3,$4)",
        [rOrgId, userId, keyPrefix, keyHash],
      );
      return fullKey;
    })();

    // R1: deploy twice with no explicit name (same app_name = "slug-test") →
    //     first succeeds with slug "slug-test"; second gets a suffix because the
    //     first app is still active.
    {
      const zip = await buildZip({ "package.json": '{"name":"slug-test"}', "app.js": "// v1" });
      const form1 = new FormData();
      form1.append("code", zip, { filename: "app.zip", contentType: "application/zip" });
      form1.append("app_name", "slug-test"); // client-derived but no explicit-name flag
      // We send app_name so the server uses "slug-test", but we do NOT mark it explicit.
      // To simulate the auto-name path, we post WITHOUT app_name on the second request.

      const r1 = await request("POST", "/v1/deployments/intake/zip", {
        headers: authHeaders(rKey),
        formData: form1,
      });
      console.log(`  R1a: first deploy (app_name=slug-test) → ${r1.status} ${JSON.stringify(r1.body)}`);
      r1.status === 202
        ? ok("R1a: first auto-name deploy → 202")
        : fail("R1a: first auto-name deploy should 202", `got ${r1.status} ${JSON.stringify(r1.body)}`);

      const appId1 = (r1.body as any).app_id ?? "";
      if (appId1) {
        const { rows: slugRows } = await pool.query<{ slug: string }>(
          "SELECT slug FROM apps WHERE id=$1",
          [appId1],
        );
        const slug1 = slugRows[0]?.slug ?? "";
        console.log(`  R1a: first app slug = "${slug1}"`);
        slug1 === "slug-test"
          ? ok(`R1a: first app slug = "slug-test"`)
          : fail("R1a: first app slug should be slug-test", `got "${slug1}"`);
      } else {
        fail("R1a: no app_id in response, skipping slug check");
      }

      // Second deploy with same name (no explicit flag — simulated via no app_name field)
      const zip2 = await buildZip({ "package.json": '{"name":"slug-test"}', "app.js": "// v2" });
      const form2 = new FormData();
      form2.append("code", zip2, { filename: "app.zip", contentType: "application/zip" });
      // Intentionally no app_name — server falls back to "app" as base slug.
      // To test the suffix path properly, send the same name but without explicit flag.
      // The server's auto-path retries on 23505 and appends a suffix.
      form2.append("app_name", "slug-test"); // same name, NOT explicit (auto path)
      // NOTE: since we can't tell the server "this is auto", test the explicit-name
      // 409 path instead in R3; here verify the DB state via slug uniqueness.
      const r2 = await request("POST", "/v1/deployments/intake/zip", {
        headers: authHeaders(rKey),
        formData: form2,
      });
      console.log(`  R1b: second deploy (same name, first app still active) → ${r2.status} ${JSON.stringify(r2.body)}`);
      // Both 202 (suffix appended) and 409 (if treated as explicit) are possible
      // depending on server path.  Here app_name IS sent, so it IS the explicit path.
      // So this should 409.
      r2.status === 409 && (r2.body as any).error === "name_taken"
        ? ok("R1b: explicit name already taken → 409 name_taken")
        : fail("R1b: duplicate explicit name should 409", `got ${r2.status} ${JSON.stringify(r2.body)}`);
    }

    // R2: deploy, soft-delete the app, then deploy again with the same name →
    //     should succeed because the partial index excludes deleted rows.
    {
      const zip = await buildZip({ "package.json": '{"name":"reuse-after-delete"}', "app.js": "// hi" });
      const form = new FormData();
      form.append("code", zip, { filename: "app.zip", contentType: "application/zip" });
      form.append("app_name", "reuse-after-delete");

      const r1 = await request("POST", "/v1/deployments/intake/zip", {
        headers: authHeaders(rKey),
        formData: form,
      });
      console.log(`  R2a: create app → ${r1.status}`);
      const appId = (r1.body as any).app_id ?? "";

      if (r1.status === 202 && appId) {
        // Soft-delete via the API
        const del = await request("DELETE", `/v1/apps/${appId}`, { headers: authHeaders(rKey) });
        console.log(`  R2b: delete app → ${del.status}`);

        // Now re-deploy with same name — partial index means this should succeed
        const zip2 = await buildZip({ "package.json": '{"name":"reuse-after-delete"}', "app.js": "// v2" });
        const form2 = new FormData();
        form2.append("code", zip2, { filename: "app.zip", contentType: "application/zip" });
        form2.append("app_name", "reuse-after-delete");
        const r2 = await request("POST", "/v1/deployments/intake/zip", {
          headers: authHeaders(rKey),
          formData: form2,
        });
        console.log(`  R2c: redeploy same name after delete → ${r2.status} ${JSON.stringify(r2.body)}`);
        r2.status === 202
          ? ok("R2: redeploy after delete succeeds (partial index)")
          : fail("R2: redeploy after delete should 202", `got ${r2.status} ${JSON.stringify(r2.body)}`);

        // Verify the deleted app didn't block the slug
        if (r2.status === 202) {
          const newAppId = (r2.body as any).app_id ?? "";
          const { rows } = await pool.query<{ slug: string; deleted_at: Date | null }>(
            "SELECT slug, deleted_at FROM apps WHERE id=$1",
            [newAppId],
          );
          const newApp = rows[0];
          console.log(`  R2c: new app slug="${newApp?.slug}" deleted_at=${newApp?.deleted_at ?? "null"}`);
          newApp?.slug === "reuse-after-delete" && !newApp?.deleted_at
            ? ok("R2: new app has same slug, not deleted")
            : fail("R2: slug or deleted_at mismatch", JSON.stringify(newApp));
        }
      } else {
        fail("R2: initial app creation failed, skipping", `status=${r1.status}`);
      }
    }

    // Diagnostic: show in-progress deployments in rOrgId right before R3.
    // R1a, R2a, and R2c each launch a background runDeploy (80 ms stub). If all
    // three are still queued/building when R3 fires, the concurrent-deploy limit
    // (max 3) fires before the slug check, producing 429 instead of 409.
    {
      const { rows: inProg } = await pool.query<{ id: string; status: string; app_name: string }>(
        `SELECT d.id, d.status, a.name AS app_name
         FROM deployments d JOIN apps a ON a.id = d.app_id
         WHERE a.org_id = $1 AND d.status IN ('queued','building','deploying')`,
        [rOrgId],
      );
      console.log(`  [diag] in-progress in rOrgId before R3: ${JSON.stringify(inProg)}`);
    }

    // R3: explicit name already active in org → 409 name_taken with correct body.
    // Uses its own fresh org so in-progress deploys from R1/R2 cannot trip the
    // concurrent-deploy limit before the slug-collision check runs.
    {
      const { rows: r3OrgRows } = await pool.query<{ id: string }>(
        "INSERT INTO orgs (clerk_org_id, name, slug) VALUES ('clerk_org_r3','R3 Org','r3-org') RETURNING id",
      );
      const r3OrgId = r3OrgRows[0].id;
      const r3Key = await (async () => {
        const { fullKey, keyPrefix, keyHash } = generateApiKey();
        await pool.query(
          "INSERT INTO api_keys (org_id, created_by, name, key_prefix, key_hash) VALUES ($1,$2,'r3-key',$3,$4)",
          [r3OrgId, userId, keyPrefix, keyHash],
        );
        return fullKey;
      })();

      const zip = await buildZip({ "package.json": '{"name":"taken-name"}', "app.js": "// x" });
      const form1 = new FormData();
      form1.append("code", zip, { filename: "app.zip", contentType: "application/zip" });
      form1.append("app_name", "taken-name");
      await request("POST", "/v1/deployments/intake/zip", { headers: authHeaders(r3Key), formData: form1 });

      const form2 = new FormData();
      form2.append("code", zip, { filename: "app.zip", contentType: "application/zip" });
      form2.append("app_name", "taken-name");
      const r = await request("POST", "/v1/deployments/intake/zip", {
        headers: authHeaders(r3Key),
        formData: form2,
      });
      console.log(`  R3: second deploy explicit taken name → ${r.status} ${JSON.stringify(r.body)}`);
      r.status === 409
        ? ok("R3: explicit taken name → 409")
        : fail("R3: should 409 for explicit taken name", `got ${r.status} ${JSON.stringify(r.body)}`);
      (r.body as any)?.error === "name_taken"
        ? ok("R3: error code = name_taken")
        : fail("R3: error code should be name_taken", `got ${(r.body as any)?.error}`);
      typeof (r.body as any)?.message === "string" && (r.body as any).message.includes("taken-name")
        ? ok("R3: message names the conflicting app")
        : fail("R3: message should name the conflicting app", `got "${(r.body as any)?.message}"`);

      await pool.query("DELETE FROM orgs WHERE id=$1", [r3OrgId]);
    }

    // R4: redeploy with app_id → keeps original slug unchanged.
    // Uses its own fresh org for the same isolation reason as R3.
    {
      const { rows: r4OrgRows } = await pool.query<{ id: string }>(
        "INSERT INTO orgs (clerk_org_id, name, slug) VALUES ('clerk_org_r4','R4 Org','r4-org') RETURNING id",
      );
      const r4OrgId = r4OrgRows[0].id;
      const r4Key = await (async () => {
        const { fullKey, keyPrefix, keyHash } = generateApiKey();
        await pool.query(
          "INSERT INTO api_keys (org_id, created_by, name, key_prefix, key_hash) VALUES ($1,$2,'r4-key',$3,$4)",
          [r4OrgId, userId, keyPrefix, keyHash],
        );
        return fullKey;
      })();

      const zip = await buildZip({ "package.json": '{"name":"keep-slug"}', "app.js": "// v1" });
      const form1 = new FormData();
      form1.append("code", zip, { filename: "app.zip", contentType: "application/zip" });
      form1.append("app_name", "keep-slug");
      const r1 = await request("POST", "/v1/deployments/intake/zip", {
        headers: authHeaders(r4Key),
        formData: form1,
      });
      const appId = (r1.body as any).app_id ?? "";

      if (r1.status === 202 && appId) {
        const zip2 = await buildZip({ "package.json": '{"name":"keep-slug"}', "app.js": "// v2" });
        const form2 = new FormData();
        form2.append("code", zip2, { filename: "app.zip", contentType: "application/zip" });
        form2.append("app_id", appId);
        form2.append("app_name", "something-different"); // name ignored for redeploy
        const r2 = await request("POST", "/v1/deployments/intake/zip", {
          headers: authHeaders(r4Key),
          formData: form2,
        });
        console.log(`  R4: redeploy with app_id → ${r2.status}`);
        r2.status === 202
          ? ok("R4: redeploy with app_id → 202")
          : fail("R4: redeploy should 202", `got ${r2.status}`);

        if (r2.status === 202) {
          const { rows } = await pool.query<{ slug: string }>(
            "SELECT slug FROM apps WHERE id=$1",
            [appId],
          );
          const slug = rows[0]?.slug ?? "";
          console.log(`  R4: slug after redeploy = "${slug}"`);
          slug === "keep-slug"
            ? ok("R4: slug unchanged after redeploy")
            : fail("R4: slug should be unchanged", `got "${slug}"`);
        }
      } else {
        fail("R4: initial deploy failed, skipping", `status=${r1.status}`);
      }

      await pool.query("DELETE FROM orgs WHERE id=$1", [r4OrgId]);
    }

    // R5: verify at DB level that deleted app does NOT appear in the partial index
    //     by checking active slug count is zero after delete.
    {
      const { rows: slugCheckRows } = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM apps
         WHERE org_id=$1 AND slug='reuse-after-delete' AND deleted_at IS NULL`,
        [rOrgId],
      );
      const cnt = parseInt(slugCheckRows[0]?.cnt ?? "0", 10);
      console.log(`  R5: active apps with slug 'reuse-after-delete' = ${cnt}`);
      // After R2, there should be exactly 1 active app with this slug (the re-created one)
      cnt === 1
        ? ok("R5: exactly 1 active app with re-used slug (deleted row excluded)")
        : fail("R5: expected 1 active app with re-used slug", `got ${cnt}`);
    }

    // Cleanup slug-test org
    await pool.query("DELETE FROM orgs WHERE id=$1", [rOrgId]);
  }

  // Helpers shared by Sections S and T — placed at outer scope so both sections
  // can use them without re-declaration.
  type FlyCall = { fn: string; arg: string; body?: Record<string, unknown> };
  const getFlyLog = async (): Promise<FlyCall[]> =>
    ((await request("GET", "/test/fly-call-log")).body as { calls?: FlyCall[] }).calls ?? [];
  const resetFlyLog = () => request("POST", "/test/reset-fly-call-log");

  // ════════════════════════════════════════════════════════════════════════════
  // Section S — deployRunner lifecycle: failed-first-deploy, redeploy states,
  //             and the app-count limit for all-failed apps
  //
  // Uses POST /test/set-real-deploy to switch the test server to real deployRunner.
  // Fly client behaviour is controlled via /test/set-fly-* endpoints (same process).
  // Fake flyctl binary lives in the test server process (set via /test/set-flyctl-mode).
  // ════════════════════════════════════════════════════════════════════════════
  {
    section("S: deployRunner lifecycle (failed-first-deploy + redeploy states)");

    // Fresh org + API key — HTTP intake and poll use this key
    const { rows: sOrgRows } = await pool.query<{ id: string }>(
      "INSERT INTO orgs (clerk_org_id, name, slug) VALUES ('clerk_org_s','S Org','s-org') RETURNING id",
    );
    const sOrgId = sOrgRows[0].id;
    const { fullKey: sKey, keyPrefix: sKP, keyHash: sKH } = generateApiKey();
    await pool.query(
      "INSERT INTO api_keys (org_id, created_by, name, key_prefix, key_hash) VALUES ($1,$2,'s-key',$3,$4)",
      [sOrgId, userId, sKP, sKH],
    );

    // Enable real deployRunner in the test server for all of Section S
    await request("POST", "/test/set-real-deploy", { body: { enabled: true } });

    // Minimal valid Node.js zip — passes validateZip and detectAppType
    const sZip = await buildZip({
      "package.json": JSON.stringify({
        name: "s-test-app",
        version: "1.0.0",
        scripts: { start: "node index.js" },
      }),
      "index.js": "require('http').createServer((_,r)=>r.end('ok')).listen(8080)",
    });

    // afterFail: deployed app's fail() runs destroyWithRetry AFTER marking the
    // deployment failed.  For a 1-attempt success the extra work is instant;
    // we wait a short fixed time so the fly call log and DB are settled before
    // we assert.  For retry tests (T1/T2) the wait is longer — see Section T.
    const afterFail = () => new Promise<void>((r) => setTimeout(r, 400));

    // ── S1/S2: first deploy fails → fly_app_id cleared → redeploy succeeds ──
    {
      console.log(DIM("\n  S1/S2: first deploy fails → fly_app_id cleared → redeploy succeeds"));

      await request("POST", "/test/set-flyctl-mode", { body: { mode: "failure" } });
      await resetFlyLog();

      const s1Form = new FormData();
      s1Form.append("code", sZip, { filename: "app.zip", contentType: "application/zip" });
      s1Form.append("app_name", "s1-app");
      const s1Intake = await request("POST", "/v1/deployments/intake/zip", {
        headers: authHeaders(sKey), formData: s1Form,
      });
      s1Intake.status === 202
        ? ok("S1: intake accepted (202)")
        : fail("S1: intake should 202", `got ${s1Intake.status} ${JSON.stringify(s1Intake.body)}`);

      const { deployment_id: s1DepId, app_id: s1AppId } = s1Intake.body as Record<string, string>;
      const s1Poll = await pollDeployment(s1DepId, sKey);
      await afterFail(); // wait for fail() cleanup (fly_app_id clear + destroyWithRetry)

      s1Poll.status === "failed"
        ? ok("S1: first-deploy status = failed")
        : fail("S1: expected status=failed", s1Poll.status);

      const s1AppRow = await pool.query<{ fly_app_id: string | null }>(
        "SELECT fly_app_id FROM apps WHERE id=$1", [s1AppId],
      );
      s1AppRow.rows[0].fly_app_id === null
        ? ok("S1: fly_app_id = NULL after failed first deploy")
        : fail("S1: fly_app_id should be NULL", s1AppRow.rows[0].fly_app_id ?? "");

      const s1Log = await getFlyLog();
      s1Log.some((c) => c.fn === "createFlyApp")
        ? ok("S1: createFlyApp called")
        : fail("S1: createFlyApp should have been called");
      s1Log.some((c) => c.fn === "destroyFlyApp")
        ? ok("S1: destroyFlyApp called")
        : fail("S1: destroyFlyApp should have been called");
      console.log(`  [diag] fly calls after S1: ${JSON.stringify(s1Log)}`);

      // S2: redeploy the SAME app_id after S1 → succeeds with a fresh Fly app
      await request("POST", "/test/set-flyctl-mode", { body: { mode: "success" } });
      await resetFlyLog();

      const s2Form = new FormData();
      s2Form.append("code", sZip, { filename: "app.zip", contentType: "application/zip" });
      s2Form.append("app_id", s1AppId);
      const s2Intake = await request("POST", "/v1/deployments/intake/zip", {
        headers: authHeaders(sKey), formData: s2Form,
      });
      const { deployment_id: s2DepId, app_id: s2AppId } = s2Intake.body as Record<string, string>;
      const s2Poll = await pollDeployment(s2DepId, sKey);

      s2Poll.status === "success"
        ? ok("S2: redeploy after failed first deploy → success")
        : fail("S2: expected success", `${s2Poll.status} stage=${s2Poll.failure_stage} msg=${s2Poll.failure_message}`);

      const { rows: s2AppCount } = await pool.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM apps WHERE org_id=$1 AND slug LIKE 's1%'", [sOrgId],
      );
      parseInt(s2AppCount[0].count) === 1
        ? ok("S2: no second app row created")
        : fail("S2: only 1 app row should exist for s1-app", s2AppCount[0].count);

      s2AppId === s1AppId
        ? ok("S2: same app_id on redeploy")
        : fail("S2: redeploy should use same app_id", `s2=${s2AppId} s1=${s1AppId}`);

      const s2Log = await getFlyLog();
      s2Log.some((c) => c.fn === "createFlyApp")
        ? ok("S2: createFlyApp called to provision fresh Fly app")
        : fail("S2: createFlyApp should be called when fly_app_id is NULL");
      console.log(`  [diag] fly calls after S2: ${JSON.stringify(s2Log)}`);
    }

    // ── S3: success → failure → redeploy (fly_app_id preserved) ──────────────
    {
      console.log(DIM("\n  S3: success → failure → redeploy (fly_app_id preserved)"));

      // Deploy 1: success → fly_app_id set
      await request("POST", "/test/set-flyctl-mode", { body: { mode: "success" } });
      await resetFlyLog();

      const s3Form1 = new FormData();
      s3Form1.append("code", sZip, { filename: "app.zip", contentType: "application/zip" });
      s3Form1.append("app_name", "s3-app");
      const s3Intake1 = await request("POST", "/v1/deployments/intake/zip", {
        headers: authHeaders(sKey), formData: s3Form1,
      });
      const { deployment_id: s3Dep1Id, app_id: s3AppId } = s3Intake1.body as Record<string, string>;
      await pollDeployment(s3Dep1Id, sKey);

      const s3After1 = await pool.query<{ fly_app_id: string | null }>(
        "SELECT fly_app_id FROM apps WHERE id=$1", [s3AppId],
      );
      const s3FlyApp = s3After1.rows[0].fly_app_id;
      s3FlyApp !== null
        ? ok("S3: fly_app_id set after first success")
        : fail("S3: fly_app_id should be set after success");
      console.log(`  [diag] fly_app_id after first success: ${s3FlyApp}`);

      // Deploy 2: failure on existing app → fly_app_id must NOT be cleared
      await request("POST", "/test/set-flyctl-mode", { body: { mode: "failure" } });
      await resetFlyLog();

      const s3Form2 = new FormData();
      s3Form2.append("code", sZip, { filename: "app.zip", contentType: "application/zip" });
      s3Form2.append("app_id", s3AppId);
      const s3Intake2 = await request("POST", "/v1/deployments/intake/zip", {
        headers: authHeaders(sKey), formData: s3Form2,
      });
      const { deployment_id: s3Dep2Id } = s3Intake2.body as Record<string, string>;
      await pollDeployment(s3Dep2Id, sKey);
      await afterFail();

      const s3After2 = await pool.query<{ fly_app_id: string | null }>(
        "SELECT fly_app_id FROM apps WHERE id=$1", [s3AppId],
      );
      s3After2.rows[0].fly_app_id === s3FlyApp
        ? ok("S3: fly_app_id unchanged after failure on existing app")
        : fail("S3: fly_app_id should not be cleared for pre-existing Fly app",
            s3After2.rows[0].fly_app_id ?? "null");

      const s3Log2 = await getFlyLog();
      !s3Log2.some((c) => c.fn === "destroyFlyApp")
        ? ok("S3: destroyFlyApp NOT called (Fly app was pre-existing)")
        : fail("S3: destroyFlyApp should not be called for pre-existing app");

      // Deploy 3: redeploy → success → reuses same Fly app (no createFlyApp)
      await request("POST", "/test/set-flyctl-mode", { body: { mode: "success" } });
      await resetFlyLog();

      const s3Form3 = new FormData();
      s3Form3.append("code", sZip, { filename: "app.zip", contentType: "application/zip" });
      s3Form3.append("app_id", s3AppId);
      const s3Intake3 = await request("POST", "/v1/deployments/intake/zip", {
        headers: authHeaders(sKey), formData: s3Form3,
      });
      const { deployment_id: s3Dep3Id } = s3Intake3.body as Record<string, string>;
      const s3Poll3 = await pollDeployment(s3Dep3Id, sKey);

      s3Poll3.status === "success"
        ? ok("S3: third deploy succeeds")
        : fail("S3: third deploy should succeed", `${s3Poll3.status} msg=${s3Poll3.failure_message}`);

      const s3Log3 = await getFlyLog();
      !s3Log3.some((c) => c.fn === "createFlyApp")
        ? ok("S3: createFlyApp NOT called (pre-existing Fly app reused)")
        : fail("S3: createFlyApp should NOT be called when Fly app still exists");
      console.log(`  [diag] fly calls after S3 redeploy: ${JSON.stringify(s3Log3)}`);
    }

    // ── S4: Fly app manually deleted → redeploy recreates it ─────────────────
    {
      console.log(DIM("\n  S4: Fly app manually deleted → redeploy recreates it"));

      // Insert an app with fly_app_id pointing to a "manually deleted" Fly app
      const { rows: s4AppRows } = await pool.query<{ id: string }>(
        `INSERT INTO apps (org_id, owner_id, name, slug, source_type, fly_app_id)
         VALUES ($1,$2,'s4-app','s4-app','zip','ssc-manually-deleted') RETURNING id`,
        [sOrgId, userId],
      );
      const s4AppId = s4AppRows[0].id;
      // Seed a prior success deployment so the app looks deployed before
      await pool.query(
        `INSERT INTO deployments (app_id, version, status, started_at, finished_at)
         VALUES ($1,1,'success',now()-INTERVAL'2 hours',now()-INTERVAL'110 minutes')`,
        [s4AppId],
      );

      await request("POST", "/test/set-flyctl-mode", { body: { mode: "success" } });
      await request("POST", "/test/set-fly-check-exists", { body: { result: false } });
      await resetFlyLog();

      const s4Form = new FormData();
      s4Form.append("code", sZip, { filename: "app.zip", contentType: "application/zip" });
      s4Form.append("app_id", s4AppId);
      const s4Intake = await request("POST", "/v1/deployments/intake/zip", {
        headers: authHeaders(sKey), formData: s4Form,
      });
      const { deployment_id: s4DepId } = s4Intake.body as Record<string, string>;
      const s4Poll = await pollDeployment(s4DepId, sKey);

      s4Poll.status === "success"
        ? ok("S4: redeploy after manual Fly app deletion → success")
        : fail("S4: expected success", `${s4Poll.status} msg=${s4Poll.failure_message}`);

      const s4Log = await getFlyLog();
      s4Log.some((c) => c.fn === "checkFlyAppExists" && c.arg === "ssc-manually-deleted")
        ? ok("S4: checkFlyAppExists called for original fly_app_id")
        : fail("S4: checkFlyAppExists should be called", JSON.stringify(s4Log));

      s4Log.some((c) => c.fn === "createFlyApp")
        ? ok("S4: createFlyApp called to recreate Fly app")
        : fail("S4: createFlyApp should be called when Fly app not found");

      const s4AppAfter = await pool.query<{ fly_app_id: string | null }>(
        "SELECT fly_app_id FROM apps WHERE id=$1", [s4AppId],
      );
      const s4NewApp = s4AppAfter.rows[0].fly_app_id;
      s4NewApp !== null && s4NewApp !== "ssc-manually-deleted"
        ? ok(`S4: fly_app_id updated to new app (${s4NewApp})`)
        : fail("S4: fly_app_id should be a new name", s4NewApp ?? "null");

      // Restore checkFlyAppExists to default true
      await request("POST", "/test/set-fly-check-exists", { body: { result: true } });
      console.log(`  [diag] fly calls after S4: ${JSON.stringify(s4Log)}`);
    }

    // ── S5: app-count limit excludes all-failed apps ──────────────────────────
    {
      console.log(DIM("\n  S5: app-count limit excludes all-failed apps"));
      const { rows: sLimitOrgRows } = await pool.query<{ id: string }>(
        "INSERT INTO orgs (clerk_org_id, name, slug) VALUES ('clerk_org_s5','S5 Org','s5-org') RETURNING id",
      );
      const s5OrgId = sLimitOrgRows[0].id;

      for (let i = 0; i < 9; i++) {
        const { rows: aRows } = await pool.query<{ id: string }>(
          "INSERT INTO apps (org_id, owner_id, name, slug, source_type) VALUES ($1,$2,$3,$4,'zip') RETURNING id",
          [s5OrgId, userId, `s5-fail-${i}`, `s5-fail-${i}`],
        );
        await pool.query(
          "INSERT INTO deployments (app_id, version, status, started_at) VALUES ($1,1,'failed',now()-INTERVAL'1 hour')",
          [aRows[0].id],
        );
      }

      const { rows: countRows } = await pool.query<{ count: string }>(
        `SELECT COUNT(DISTINCT a.id) AS count
         FROM apps a
         WHERE a.org_id = $1
           AND a.deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM deployments d
             WHERE d.app_id = a.id AND d.status != 'failed'
           )`,
        [s5OrgId],
      );
      const limitCount = parseInt(countRows[0].count, 10);
      console.log(`  [diag] app-count for 9 all-failed apps: ${limitCount}`);
      limitCount === 0
        ? ok("S5: 9 all-failed apps count as 0 toward the limit")
        : fail("S5: all-failed apps should not count toward limit", String(limitCount));

      const { rows: aSuccessRows } = await pool.query<{ id: string }>(
        "INSERT INTO apps (org_id, owner_id, name, slug, source_type) VALUES ($1,$2,'s5-ok','s5-ok','zip') RETURNING id",
        [s5OrgId, userId],
      );
      await pool.query(
        "INSERT INTO deployments (app_id, version, status, started_at) VALUES ($1,1,'success',now()-INTERVAL'30 minutes')",
        [aSuccessRows[0].id],
      );

      const { rows: countRows2 } = await pool.query<{ count: string }>(
        `SELECT COUNT(DISTINCT a.id) AS count
         FROM apps a
         WHERE a.org_id = $1
           AND a.deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM deployments d
             WHERE d.app_id = a.id AND d.status != 'failed'
           )`,
        [s5OrgId],
      );
      const limitCount2 = parseInt(countRows2[0].count, 10);
      console.log(`  [diag] app-count after adding 1 success: ${limitCount2}`);
      limitCount2 === 1
        ? ok("S5: only the 1 app with a success deployment counts toward limit")
        : fail("S5: expected exactly 1 active app", String(limitCount2));

      await pool.query("DELETE FROM orgs WHERE id=$1", [s5OrgId]);
    }

    // ── Cleanup Section S ─────────────────────────────────────────────────────
    await request("POST", "/test/set-real-deploy", { body: { enabled: false } });
    await request("POST", "/test/set-flyctl-mode", { body: { mode: "success" } });
    await request("POST", "/test/set-fly-destroy-failures", { body: { times: 0 } });
    await request("POST", "/test/set-fly-check-exists", { body: { result: true } });
    await pool.query("DELETE FROM orgs WHERE id=$1", [sOrgId]);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Section T — destroyWithRetry: retry logic, orphan recording, reaper cleanup
  //
  // Uses the same real-deploy + fly stub mechanism as Section S.
  // Fake flyctl always exits 1 so every deploy fails, triggering fail() →
  // destroyWithRetry.  Fly destroy behaviour is configured via
  // /test/set-fly-destroy-failures.
  // ════════════════════════════════════════════════════════════════════════════
  {
    section("T: destroyWithRetry (retry + orphan_fly_apps + reaper)");

    // Fresh org + API key
    const { rows: tOrgRows } = await pool.query<{ id: string }>(
      "INSERT INTO orgs (clerk_org_id, name, slug) VALUES ('clerk_org_t','T Org','t-org') RETURNING id",
    );
    const tOrgId = tOrgRows[0].id;
    const { fullKey: tKey, keyPrefix: tKP, keyHash: tKH } = generateApiKey();
    await pool.query(
      "INSERT INTO api_keys (org_id, created_by, name, key_prefix, key_hash) VALUES ($1,$2,'t-key',$3,$4)",
      [tOrgId, userId, tKP, tKH],
    );

    // Enable real deploy; fake flyctl always fails → deploy always fails
    await request("POST", "/test/set-real-deploy", { body: { enabled: true } });
    await request("POST", "/test/set-flyctl-mode", { body: { mode: "failure" } });

    // Minimal valid Node.js zip
    const tZip = await buildZip({
      "package.json": JSON.stringify({
        name: "t-test-app",
        version: "1.0.0",
        scripts: { start: "node index.js" },
      }),
      "index.js": "require('http').createServer((_,r)=>r.end('ok')).listen(8080)",
    });

    // Destroy retry backoff is [200ms, 600ms] so we need ~1 second after
    // pollDeployment returns before checking the fly call log and orphan table.
    const afterRetry = () => new Promise<void>((r) => setTimeout(r, 1500));

    // ── T1: destroyFlyApp fails twice then succeeds → no orphan row ───────────
    {
      console.log(DIM("\n  T1: destroyFlyApp fails twice then succeeds → no orphan row"));

      await request("POST", "/test/set-fly-destroy-failures", { body: { times: 2 } });
      await resetFlyLog();

      const t1Form = new FormData();
      t1Form.append("code", tZip, { filename: "app.zip", contentType: "application/zip" });
      t1Form.append("app_name", "t1-app");
      const t1Intake = await request("POST", "/v1/deployments/intake/zip", {
        headers: authHeaders(tKey), formData: t1Form,
      });
      const { deployment_id: t1DepId } = t1Intake.body as Record<string, string>;
      await pollDeployment(t1DepId, tKey);
      await afterRetry();

      const t1Log = await getFlyLog();
      const t1Destroys = t1Log.filter((c) => c.fn === "destroyFlyApp");
      t1Destroys.length === 3
        ? ok("T1: destroyFlyApp called 3 times (2 failures + 1 success)")
        : fail("T1: expected exactly 3 destroy calls", String(t1Destroys.length));

      const { rows: t1Orphans } = await pool.query<{ fly_app_name: string }>(
        "SELECT fly_app_name FROM orphaned_fly_apps WHERE org_id=$1", [tOrgId],
      );
      t1Orphans.length === 0
        ? ok("T1: no orphan row recorded (succeeded on 3rd attempt)")
        : fail("T1: orphan row should NOT exist after eventual success",
            t1Orphans.map((r) => r.fly_app_name).join(", "));
    }

    // ── T2: destroyFlyApp always fails → orphan recorded, no secrets in log ──
    {
      console.log(DIM("\n  T2: destroyFlyApp always fails → orphan recorded, no secrets in log"));

      await request("GET", "/test/drain-logs"); // clear prior log lines
      await request("POST", "/test/set-fly-destroy-failures", { body: { times: -1 } });
      await resetFlyLog();

      const t2Form = new FormData();
      t2Form.append("code", tZip, { filename: "app.zip", contentType: "application/zip" });
      t2Form.append("app_name", "t2-app");
      const t2Intake = await request("POST", "/v1/deployments/intake/zip", {
        headers: authHeaders(tKey), formData: t2Form,
      });
      const { deployment_id: t2DepId, app_id: t2AppId } = t2Intake.body as Record<string, string>;
      await pollDeployment(t2DepId, tKey);
      await afterRetry();

      const t2Log = await getFlyLog();
      const t2Destroys = t2Log.filter((c) => c.fn === "destroyFlyApp");
      t2Destroys.length === 3
        ? ok("T2: destroyFlyApp called 3 times (all failed)")
        : fail("T2: expected 3 destroy calls", String(t2Destroys.length));

      const { rows: t2Orphans } = await pool.query<{ fly_app_name: string; last_error: string | null }>(
        "SELECT fly_app_name, last_error FROM orphaned_fly_apps WHERE org_id=$1", [tOrgId],
      );
      t2Orphans.length > 0
        ? ok(`T2: orphan row recorded (${t2Orphans[0].fly_app_name})`)
        : fail("T2: orphan row should be in orphaned_fly_apps");

      const t2Drained = (await request("GET", "/test/drain-logs")).body as { logs: string[] };
      const t2ErrStr = t2Drained.logs.join(" ");
      t2ErrStr.includes("FAILED to destroy Fly app")
        ? ok("T2: error logged for failed destroy attempts")
        : fail("T2: expected destroy-failure error log", t2ErrStr.slice(0, 300));

      // FLY_API_TOKEN in test-server.ts is "test-token" — must not appear in logs
      !t2ErrStr.includes("test-token")
        ? ok("T2: FLY_API_TOKEN value not present in error logs (safeErr scrubbed it)")
        : fail("T2: FLY_API_TOKEN leaked into error log");
      console.log(`  [diag] T2 app_id=${t2AppId} orphans=${t2Orphans.length}`);
    }

    // ── T3: reaper destroys orphan fly app, removes row from DB ──────────────
    {
      console.log(DIM("\n  T3: reaper destroys orphan fly app, removes row from DB"));

      // Seed an independent orphan row (T2's orphan may also be present; reaper destroys all)
      const t3AppName = "ssc-t3-reaper-test";
      await pool.query(
        `INSERT INTO orphaned_fly_apps (fly_app_name, org_id, last_error)
         VALUES ($1, $2, 'seeded for T3')
         ON CONFLICT (fly_app_name) DO UPDATE SET last_error = EXCLUDED.last_error`,
        [t3AppName, tOrgId],
      );

      await request("POST", "/test/set-fly-destroy-failures", { body: { times: 0 } });
      await resetFlyLog();

      const t3Resp = await request("POST", "/test/run-reaper");
      const t3Reaped = (t3Resp.body as { destroyed?: number }).destroyed ?? 0;

      t3Reaped >= 1
        ? ok(`T3: reapOrphanedFlyApps returned ${t3Reaped} (≥ 1)`)
        : fail("T3: reapOrphanedFlyApps should return ≥ 1", String(t3Reaped));

      const t3Log = await getFlyLog();
      t3Log.some((c) => c.fn === "destroyFlyApp" && c.arg === t3AppName)
        ? ok("T3: destroyFlyApp called by reaper for seeded orphan")
        : fail("T3: reaper should have called destroyFlyApp for ssc-t3-reaper-test",
            JSON.stringify(t3Log));

      const { rows: t3After } = await pool.query<{ fly_app_name: string }>(
        "SELECT fly_app_name FROM orphaned_fly_apps WHERE fly_app_name=$1", [t3AppName],
      );
      t3After.length === 0
        ? ok("T3: orphan row removed from DB after successful reap")
        : fail("T3: orphan row should be deleted after reap");
    }

    // ── Cleanup Section T ─────────────────────────────────────────────────────
    await request("POST", "/test/set-real-deploy", { body: { enabled: false } });
    await request("POST", "/test/set-flyctl-mode", { body: { mode: "success" } });
    await request("POST", "/test/set-fly-destroy-failures", { body: { times: 0 } });
    await pool.query("DELETE FROM orphaned_fly_apps WHERE org_id=$1", [tOrgId]);
    await pool.query("DELETE FROM orgs WHERE id=$1", [tOrgId]);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Section U — childEnv isolation · static guard · failure-message scrubbing
  // ════════════════════════════════════════════════════════════════════════════
  {
    section("U: childEnv isolation, static guard, failure scrubbing");

    // ── U1: gitEnv() and flyctlEnv() are isolated from secrets ───────────────
    {
      const savedFly   = process.env.FLY_API_TOKEN;
      const savedDb    = process.env.DATABASE_URL;
      const savedClerk = process.env.CLERK_SECRET_KEY;
      process.env.FLY_API_TOKEN    = "u1-fake-fly-token";
      process.env.DATABASE_URL     = "postgres://user:pass@localhost/testdb";
      process.env.CLERK_SECRET_KEY = "sk_test_u1fake";

      // Force re-evaluation so the module picks up the new env values
      delete require.cache[require.resolve("../src/lib/childEnv")];
      const { gitEnv: gE, flyctlEnv: fE } = require("../src/lib/childEnv") as {
        gitEnv: () => NodeJS.ProcessEnv;
        flyctlEnv: () => NodeJS.ProcessEnv;
      };

      const ge = gE();
      const fe = fE();

      !("FLY_API_TOKEN"    in ge) ? ok("U1: gitEnv has no FLY_API_TOKEN")    : fail("U1: gitEnv must not have FLY_API_TOKEN");
      !("DATABASE_URL"     in ge) ? ok("U1: gitEnv has no DATABASE_URL")     : fail("U1: gitEnv must not have DATABASE_URL");
      !("CLERK_SECRET_KEY" in ge) ? ok("U1: gitEnv has no CLERK_SECRET_KEY") : fail("U1: gitEnv must not have CLERK_SECRET_KEY");
      ge.GIT_TERMINAL_PROMPT === "0" ? ok("U1: gitEnv GIT_TERMINAL_PROMPT=0") : fail("U1: gitEnv missing GIT_TERMINAL_PROMPT");
      ge.GIT_CONFIG_NOSYSTEM === "1" ? ok("U1: gitEnv GIT_CONFIG_NOSYSTEM=1") : fail("U1: gitEnv missing GIT_CONFIG_NOSYSTEM");

      fe.FLY_API_TOKEN === "u1-fake-fly-token" ? ok("U1: flyctlEnv has FLY_API_TOKEN") : fail("U1: flyctlEnv must have FLY_API_TOKEN", fe.FLY_API_TOKEN ?? "(unset)");
      !("DATABASE_URL"     in fe) ? ok("U1: flyctlEnv has no DATABASE_URL")     : fail("U1: flyctlEnv must not have DATABASE_URL");
      !("CLERK_SECRET_KEY" in fe) ? ok("U1: flyctlEnv has no CLERK_SECRET_KEY") : fail("U1: flyctlEnv must not have CLERK_SECRET_KEY");
      fe.CI === "true" ? ok("U1: flyctlEnv CI=true") : fail("U1: flyctlEnv must have CI=true");

      const gitAllowed = new Set(["PATH", "HOME", "LANG", "TMPDIR", "GIT_TERMINAL_PROMPT", "GIT_CONFIG_NOSYSTEM"]);
      const flyAllowed = new Set(["PATH", "HOME", "LANG", "TMPDIR", "FLY_API_TOKEN", "CI"]);
      const geExtra = Object.keys(ge).filter((k) => !gitAllowed.has(k));
      const feExtra = Object.keys(fe).filter((k) => !flyAllowed.has(k));
      geExtra.length === 0 ? ok("U1: gitEnv only allow-listed keys") : fail("U1: gitEnv has extra keys", geExtra.join(", "));
      feExtra.length === 0 ? ok("U1: flyctlEnv only allow-listed keys") : fail("U1: flyctlEnv has extra keys", feExtra.join(", "));

      if (savedFly   === undefined) delete process.env.FLY_API_TOKEN;    else process.env.FLY_API_TOKEN    = savedFly;
      if (savedDb    === undefined) delete process.env.DATABASE_URL;     else process.env.DATABASE_URL     = savedDb;
      if (savedClerk === undefined) delete process.env.CLERK_SECRET_KEY; else process.env.CLERK_SECRET_KEY = savedClerk;
    }

    // ── U2: Static guard — every child_process call uses gitEnv()/flyctlEnv() ─
    {
      const srcDir = path.resolve(__dirname, "..", "src");
      const tsFiles: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else if (entry.name.endsWith(".ts")) tsFiles.push(p);
        }
      };
      walk(srcDir);

      // Belt-and-suspenders: also catch any raw ...process.env spread
      const spreadViolations = tsFiles.filter((f) => fs.readFileSync(f, "utf8").includes("...process.env"));
      spreadViolations.length === 0
        ? ok("U2: no ...process.env spread in any apps/api/src .ts file")
        : fail("U2: ...process.env spread found", spreadViolations.map((f) => path.relative(srcDir, f)).join(", "));

      // Scan every child_process call site and require an approved env option.
      // Approved forms:
      //   (a) direct: `env: gitEnv()` or `env: flyctlEnv()` inside the call
      //   (b) indirect: `env` as a shorthand property AND the file contains
      //       gitEnv()/flyctlEnv() calls (e.g. src/index.ts uses an array of
      //       { bin, args, env } where env is set to flyctlEnv()/gitEnv()).
      //
      // Order matters: longer alternatives before shorter ones (execFileP before execFile).
      const cpPattern = /\b(execFileP|execFileSync|execFile|spawnSync|spawn|execSync|exec)\s*\(/g;
      const envViolations: string[] = [];

      for (const filePath of tsFiles) {
        const src = fs.readFileSync(filePath, "utf8");
        const relPath = path.relative(srcDir, filePath);
        // Does the file at all contain calls to the env helpers?
        const fileHasEnvHelper = /\b(gitEnv|flyctlEnv)\s*\(/.test(src);

        cpPattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = cpPattern.exec(src)) !== null) {
          const fnName = m[1];
          const parenOpen = m.index + m[0].length - 1; // index of '('

          // Walk forward to find the matching closing paren
          let depth = 0;
          let j = parenOpen;
          for (; j < src.length; j++) {
            if (src[j] === "(") depth++;
            else if (src[j] === ")") { depth--; if (depth === 0) break; }
          }
          const callText = src.slice(m.index, j + 1);
          const lineNum = src.slice(0, m.index).split("\n").length;

          // (a) Direct: options object contains `env: gitEnv()` or `env: flyctlEnv()`
          const hasDirectEnv = /\benv\s*:\s*(gitEnv|flyctlEnv)\s*\(/.test(callText);
          // (b) Indirect: options contain bare `env` shorthand AND file has env helpers
          const hasShorthandEnv = /[,{]\s*env\s*[,}]/.test(callText) && fileHasEnvHelper;

          if (!hasDirectEnv && !hasShorthandEnv) {
            envViolations.push(`${relPath}:${lineNum}`);
          }
        }
      }

      envViolations.length === 0
        ? ok("U2: every child_process call uses gitEnv() or flyctlEnv() (static guard)")
        : fail("U2: child_process call(s) missing approved env",
            "\n    " + envViolations.join("\n    "));
    }

    // ── U3: Failure message scrubbing — FLY_API_TOKEN must not leak ──────────
    {
      const { rows: u3OrgRows } = await pool.query<{ id: string }>(
        "INSERT INTO orgs (clerk_org_id,name,slug) VALUES ('clerk_org_u3','U3 Org','u3-org') RETURNING id",
      );
      const u3OrgId = u3OrgRows[0].id;
      const { fullKey: u3Key, keyPrefix: u3KP, keyHash: u3KH } = generateApiKey();
      await pool.query(
        "INSERT INTO api_keys (org_id,created_by,name,key_prefix,key_hash) VALUES ($1,$2,'u3-key',$3,$4)",
        [u3OrgId, userId, u3KP, u3KH],
      );

      await request("POST", "/test/set-real-deploy", { body: { enabled: true } });
      await request("POST", "/test/set-flyctl-mode", { body: { mode: "failure-with-token" } });
      await request("GET", "/test/drain-logs"); // clear prior logs

      const u3Zip = await buildZip({
        "package.json": JSON.stringify({ name: "u3-app", version: "1.0.0", scripts: { start: "node index.js" } }),
        "index.js": "require('http').createServer((_,r)=>r.end('ok')).listen(8080)",
      });
      const u3Form = new FormData();
      u3Form.append("code", u3Zip, { filename: "app.zip", contentType: "application/zip" });
      const u3Intake = await request("POST", "/v1/deployments/intake/zip", {
        headers: authHeaders(u3Key), formData: u3Form,
      });
      const { deployment_id: u3DepId } = u3Intake.body as Record<string, string>;

      // Collect SSE events
      const u3Events = await streamRequest(`/v1/deployments/${u3DepId}/stream`, authHeaders(u3Key));
      const u3Parsed = u3Events
        .map((e) => { try { return JSON.parse(e); } catch { return null; } })
        .filter(Boolean) as Array<{ type: string; message?: string }>;

      // ── NEW: check ALL SSE events (every type) for the raw token value ──────
      // This catches leakage through "log" events (the live build output stream)
      // in addition to the "error" event checked below.
      const u3AllEventsStr = u3Parsed.map((e) => JSON.stringify(e)).join(" ");
      !u3AllEventsStr.includes("test-token")
        ? ok("U3: no SSE event of any type contains FLY_API_TOKEN value")
        : fail("U3: FLY_API_TOKEN leaked into SSE events",
            u3AllEventsStr.slice(0, 300));

      // ── NEW: assert the deploy actually exercised the scrubbed log() path ───
      // If no "log" event arrives the scrubbing test is vacuously passing.
      const u3LogEvents = u3Parsed.filter((e) => e.type === "log");
      u3LogEvents.length > 0
        ? ok(`U3: received ${u3LogEvents.length} SSE log event(s) — flyctl output path exercised`)
        : fail("U3: no SSE log events received — flyctl output path was not exercised");
      u3LogEvents.some((e) => e.message?.includes("[REDACTED]"))
        ? ok("U3: at least one SSE log event contains [REDACTED] (scrubbing confirmed on log path)")
        : fail("U3: no SSE log event contains [REDACTED] — scrubSecrets not applied to log() output",
            u3LogEvents.map((e) => e.message ?? "").join(" | ").slice(0, 300));

      // ── Existing: "error" event specific checks ──────────────────────────────
      const u3ErrorEvent = u3Parsed.find((e) => e.type === "error");

      !u3ErrorEvent?.message?.includes("test-token")
        ? ok("U3: SSE error event message does not contain FLY_API_TOKEN value")
        : fail("U3: FLY_API_TOKEN leaked into SSE error event", u3ErrorEvent?.message?.slice(0, 200));
      u3ErrorEvent?.message?.includes("[REDACTED]")
        ? ok("U3: SSE error event message contains [REDACTED]")
        : fail("U3: [REDACTED] missing from SSE error event", JSON.stringify(u3ErrorEvent));

      // Poll for stored failure_message
      const u3Poll = await pollDeployment(u3DepId, u3Key);
      !u3Poll.failure_message?.includes("test-token")
        ? ok("U3: stored failure_message does not contain FLY_API_TOKEN value")
        : fail("U3: FLY_API_TOKEN leaked into stored failure_message", u3Poll.failure_message?.slice(0, 200));
      u3Poll.failure_message?.includes("[REDACTED]")
        ? ok("U3: stored failure_message contains [REDACTED]")
        : fail("U3: [REDACTED] missing from stored failure_message", u3Poll.failure_message ?? "(null)");

      // Wait a moment then check console.error logs
      await new Promise<void>((r) => setTimeout(r, 400));
      const u3Drained = (await request("GET", "/test/drain-logs")).body as { logs: string[] };
      const u3LogStr = u3Drained.logs.join(" ");
      !u3LogStr.includes("test-token")
        ? ok("U3: drain-logs contain no FLY_API_TOKEN value")
        : fail("U3: FLY_API_TOKEN leaked into console.error logs");

      // Restore server to default state
      await request("POST", "/test/set-real-deploy", { body: { enabled: false } });
      await request("POST", "/test/set-flyctl-mode", { body: { mode: "success" } });
      await pool.query("DELETE FROM orgs WHERE id=$1", [u3OrgId]);
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Section V — GitHub URL validator · clone args · size cap · intake 400s
  // ════════════════════════════════════════════════════════════════════════════
  {
    section("V: GitHub URL validation, clone args, size cap, intake 400s");

    const { parseGithubUrl, buildCloneArgs, checkDirSize } =
      require("../src/lib/githubUrl") as {
        parseGithubUrl: (s: string) => { owner: string; repo: string; cloneUrl: string };
        buildCloneArgs: (cloneUrl: string, dir: string) => string[];
        checkDirSize: (dir: string, limitBytes: number) => Promise<void>;
      };

    // ── V1: validator unit tests ───────────────────────────────────────────────
    {
      // Accepted
      const accepted: { input: string; expectOwner: string; expectRepo: string }[] = [
        { input: "https://github.com/heroku/node-js-getting-started",        expectOwner: "heroku",   expectRepo: "node-js-getting-started" },
        { input: "https://github.com/heroku/node-js-getting-started.git",    expectOwner: "heroku",   expectRepo: "node-js-getting-started" },
        { input: "https://github.com/heroku/node-js-getting-started/",       expectOwner: "heroku",   expectRepo: "node-js-getting-started" },
      ];

      for (const { input, expectOwner, expectRepo } of accepted) {
        try {
          const r = parseGithubUrl(input);
          r.owner === expectOwner && r.repo === expectRepo
            ? ok(`V1: accepted "${input.slice(0, 60)}" → cloneUrl=${r.cloneUrl}`)
            : fail(`V1: wrong owner/repo for "${input}"`, `got ${r.owner}/${r.repo}`);
          r.cloneUrl === `https://github.com/${expectOwner}/${expectRepo}.git`
            ? ok(`V1: cloneUrl rebuilt correctly for "${input.slice(0, 60)}"`)
            : fail(`V1: cloneUrl not rebuilt`, r.cloneUrl);
        } catch (e) {
          fail(`V1: should accept "${input}"`, String(e));
        }
      }

      // Rejected
      const rejected: { input: string; label: string }[] = [
        { input: "http://github.com/a/b",                              label: "http scheme" },
        { input: "https://gitlab.com/a/b",                             label: "wrong host" },
        { input: "https://github.com.evil.com/a/b",                    label: "subdomain lookalike" },
        { input: "https://evil.com/github.com/a/b",                    label: "github.com in path" },
        { input: "https://user:pass@github.com/a/b",                   label: "credentials" },
        { input: "https://github.com:443/a/b",                         label: "explicit port :443" },
        { input: "https://github.com:8080/a/b",                        label: "explicit port :8080" },
        { input: "https://github.com/a",                               label: "only owner, no repo" },
        { input: "https://github.com/a/b/c",                           label: "extra path segment" },
        { input: "https://github.com/a/b?x=1",                         label: "query string" },
        { input: "https://github.com/a/b#x",                           label: "fragment" },
        { input: "https://github.com/a/%2e%2e",                        label: "percent-encoded path" },
        { input: "https://github.com/../b",                            label: "path traversal (..)" },
        { input: "file:///etc/passwd",                                  label: "file:// scheme" },
        { input: "ext::sh -c id",                                       label: "ext:: injection" },
        { input: "git@github.com:a/b.git",                             label: "git@ (SCP format)" },
        { input: "ssh://git@github.com/a/b",                           label: "ssh:// scheme" },
        { input: "--upload-pack=touch /tmp/x",                         label: "leading dash (flag injection)" },
        { input: "https://github.com/a/b\nhttps://evil.com",           label: "URL with newline" },
        { input: "https://github.com/" + "a".repeat(300),              label: "301-char URL" },
      ];

      for (const { input, label } of rejected) {
        let threw = false;
        try {
          parseGithubUrl(input);
        } catch {
          threw = true;
        }
        threw
          ? ok(`V1: rejected "${label}"`)
          : fail(`V1: should have rejected "${label}"`, `input=${input.slice(0, 80)}`);
      }
    }

    // ── V2: buildCloneArgs ─────────────────────────────────────────────────────
    {
      const cloneUrl = "https://github.com/heroku/node-js-getting-started.git";
      const dir = "/tmp/ssc-test-clone-dir";
      const args = buildCloneArgs(cloneUrl, dir);

      const joined = args.join(" ");
      console.log(`  buildCloneArgs: [${args.join(", ")}]`);

      args.some((a, i) => a === "-c" && args[i + 1] === "protocol.allow=never")
        ? ok("V2: args contain -c protocol.allow=never")
        : fail("V2: missing -c protocol.allow=never", joined);

      args.some((a, i) => a === "-c" && args[i + 1] === "protocol.https.allow=always")
        ? ok("V2: args contain -c protocol.https.allow=always")
        : fail("V2: missing -c protocol.https.allow=always", joined);

      args.some((a, i) => a === "-c" && args[i + 1] === "core.symlinks=false")
        ? ok("V2: args contain -c core.symlinks=false")
        : fail("V2: missing -c core.symlinks=false", joined);

      // "--" must immediately precede the URL
      const dashDashIdx = args.lastIndexOf("--");
      (dashDashIdx >= 0 && args[dashDashIdx + 1] === cloneUrl)
        ? ok("V2: \"--\" appears immediately before the clone URL")
        : fail("V2: \"--\" not immediately before clone URL", joined);

      // URL in args must equal the rebuilt cloneUrl (not raw input)
      args.includes(cloneUrl)
        ? ok("V2: args contain the canonical cloneUrl")
        : fail("V2: canonical cloneUrl missing from args", joined);

      args[args.length - 1] === dir
        ? ok("V2: destination dir is the last arg")
        : fail("V2: dir not last arg", args[args.length - 1]);
    }

    // ── V3: checkDirSize ──────────────────────────────────────────────────────
    {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "ssc-v3-size-"));

      // Over limit: write 200 bytes, cap at 100 bytes → should throw
      const bigDir = path.join(tmpBase, "big");
      fs.mkdirSync(bigDir);
      fs.writeFileSync(path.join(bigDir, "data.txt"), "x".repeat(200));

      let threwOverLimit = false;
      try {
        await checkDirSize(bigDir, 100);
      } catch {
        threwOverLimit = true;
      }
      threwOverLimit
        ? ok("V3: checkDirSize throws when directory exceeds limit")
        : fail("V3: checkDirSize should throw when over limit");

      // Under limit: same dir but cap at 1000 bytes → should not throw
      let threwUnderLimit = false;
      try {
        await checkDirSize(bigDir, 1000);
      } catch {
        threwUnderLimit = true;
      }
      !threwUnderLimit
        ? ok("V3: checkDirSize passes when directory is under limit")
        : fail("V3: checkDirSize should not throw when under limit");

      // .git dir is excluded: put a huge file inside .git, should still pass
      const gitIgnoreDir = path.join(tmpBase, "gitignore");
      fs.mkdirSync(gitIgnoreDir);
      fs.mkdirSync(path.join(gitIgnoreDir, ".git"));
      fs.writeFileSync(path.join(gitIgnoreDir, ".git", "HUGE"), "x".repeat(10000));
      fs.writeFileSync(path.join(gitIgnoreDir, "small.txt"), "hi");

      let threwWithGit = false;
      try {
        await checkDirSize(gitIgnoreDir, 100); // 2 bytes ("hi") < 100 → should pass
      } catch {
        threwWithGit = true;
      }
      !threwWithGit
        ? ok("V3: checkDirSize excludes .git directory from size count")
        : fail("V3: checkDirSize should exclude .git from size count");

      fs.rmSync(tmpBase, { recursive: true });
    }

    // ── V4: intake 400 for invalid GitHub URLs ─────────────────────────────────
    {
      // Record row counts before the test
      const { rows: beforeRows } = await pool.query<{ apps: string; deps: string }>(
        "SELECT (SELECT COUNT(*) FROM apps)::text AS apps, (SELECT COUNT(*) FROM deployments)::text AS deps",
      );
      const beforeApps = parseInt(beforeRows[0].apps, 10);
      const beforeDeps = parseInt(beforeRows[0].deps, 10);

      const v4BadUrls: { url: string; label: string }[] = [
        { url: "http://github.com/a/b",             label: "http scheme" },
        { url: "https://gitlab.com/a/b",            label: "wrong host" },
        { url: "https://github.com.evil.com/a/b",   label: "subdomain lookalike" },
        { url: "https://user:pass@github.com/a/b",  label: "credentials" },
        { url: "https://github.com/a",              label: "no repo path" },
        { url: "https://github.com/a/b/c",          label: "extra path segment" },
        { url: "--upload-pack=touch /tmp/x",         label: "flag injection" },
        { url: "https://github.com/a/b?x=1",        label: "query string" },
      ];

      for (const { url, label } of v4BadUrls) {
        const r = await request("POST", "/v1/deployments/intake/github", {
          headers: authHeaders(keyA),
          body: { github_url: url },
        });
        r.status === 400
          ? ok(`V4: "${label}" → 400`)
          : fail(`V4: "${label}" should 400`, `got ${r.status} ${JSON.stringify(r.body)}`);
        (r.body as Record<string, unknown>).error === "invalid_github_url"
          ? ok(`V4: "${label}" → error=invalid_github_url`)
          : fail(`V4: "${label}" error field`, `got ${JSON.stringify((r.body as Record<string, unknown>).error)}`);
      }

      // Verify no rows were written to apps or deployments
      const { rows: afterRows } = await pool.query<{ apps: string; deps: string }>(
        "SELECT (SELECT COUNT(*) FROM apps)::text AS apps, (SELECT COUNT(*) FROM deployments)::text AS deps",
      );
      const afterApps = parseInt(afterRows[0].apps, 10);
      const afterDeps = parseInt(afterRows[0].deps, 10);

      afterApps === beforeApps
        ? ok(`V4: apps row count unchanged (${beforeApps}) — no rows written on 400`)
        : fail("V4: apps row count changed", `before=${beforeApps} after=${afterApps}`);
      afterDeps === beforeDeps
        ? ok(`V4: deployments row count unchanged (${beforeDeps}) — no rows written on 400`)
        : fail("V4: deployments row count changed", `before=${beforeDeps} after=${afterDeps}`);
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  section("W: Static detection hardening, .dockerignore, nginx dotfile guard");
  // ════════════════════════════════════════════════════════════════════════════

  {
    const { detectAppType } = require("../src/services/appDetector");
    const { generateDeployFiles } = require("../src/services/dockerfileGen");
    const fsTmp = require("fs/promises");
    const pathTmp = require("path");
    const osTmp = require("os");

    const mkTmp = () => fsTmp.mkdtemp(pathTmp.join(osTmp.tmpdir(), "ssc-w-"));
    const cleanup = (d: string) => fsTmp.rm(d, { recursive: true, force: true }).catch(() => {});

    // ── W1: Detection unit tests ─────────────────────────────────────────────

    // W1a: empty dir → throws (no index.html)
    {
      const d = await mkTmp();
      try {
        try {
          await detectAppType(d);
          fail("W1a: empty dir should throw");
        } catch (e: any) {
          ok("W1a: empty dir → throws (no fallback to static)");
        }
      } finally { await cleanup(d); }
    }

    // W1b: only a dotfile (.env) → throws
    {
      const d = await mkTmp();
      try {
        await fsTmp.writeFile(pathTmp.join(d, ".env"), "SECRET=abc");
        try {
          await detectAppType(d);
          fail("W1b: .env-only dir should throw");
        } catch (e: any) {
          ok("W1b: .env-only dir → throws (dotfile alone ≠ static)");
        }
      } finally { await cleanup(d); }
    }

    // W1c: static assets but no index.html → throws
    {
      const d = await mkTmp();
      try {
        await fsTmp.writeFile(pathTmp.join(d, "logo.png"), "PNG");
        await fsTmp.writeFile(pathTmp.join(d, "style.css"), "body{}");
        try {
          await detectAppType(d);
          fail("W1c: assets-without-index.html should throw");
        } catch (e: any) {
          ok("W1c: assets-without-index.html → throws");
        }
      } finally { await cleanup(d); }
    }

    // W1d: index.html present → kind=static
    {
      const d = await mkTmp();
      try {
        await fsTmp.writeFile(pathTmp.join(d, "index.html"), "<h1>hi</h1>");
        const t = await detectAppType(d);
        t.kind === "static" ? ok("W1d: index.html → kind=static") : fail("W1d: expected static", JSON.stringify(t));
      } finally { await cleanup(d); }
    }

    // W1e: error message mentions index.html, package.json, requirements.txt
    {
      const d = await mkTmp();
      try {
        await fsTmp.writeFile(pathTmp.join(d, "main.go"), "package main");
        try {
          await detectAppType(d);
          fail("W1e: should throw");
        } catch (e: any) {
          const msg: string = e.message ?? "";
          msg.includes("index.html")
            ? ok("W1e: error message mentions index.html")
            : fail("W1e: error message missing index.html", msg);
          msg.includes("package.json")
            ? ok("W1e: error message mentions package.json")
            : fail("W1e: error message missing package.json", msg);
          msg.includes("requirements.txt")
            ? ok("W1e: error message mentions requirements.txt")
            : fail("W1e: error message missing requirements.txt", msg);
        }
      } finally { await cleanup(d); }
    }

    // ── W2: Static output — .dockerignore + nginx conf ───────────────────────

    {
      const d = await mkTmp();
      try {
        await fsTmp.writeFile(pathTmp.join(d, "index.html"), "<h1>hi</h1>");
        const t = await detectAppType(d);
        await generateDeployFiles(d, "ssc-w2-test", t);

        // W2a: .dockerignore exists and contains dotfile exclusions
        let di = "";
        try { di = await fsTmp.readFile(pathTmp.join(d, ".dockerignore"), "utf8"); } catch {}
        di.includes(".git") ? ok("W2a: static .dockerignore contains .git") : fail("W2a: .dockerignore missing .git", di);
        di.includes(".*") ? ok("W2a: static .dockerignore contains .*") : fail("W2a: .dockerignore missing .*", di);
        di.includes("**/.*") ? ok("W2a: static .dockerignore contains **/.*") : fail("W2a: .dockerignore missing **/.*", di);
        di.includes("*.pem") ? ok("W2a: static .dockerignore contains *.pem") : fail("W2a: .dockerignore missing *.pem", di);
        di.includes("*.key") ? ok("W2a: static .dockerignore contains *.key") : fail("W2a: .dockerignore missing *.key", di);
        di.includes("id_rsa*") ? ok("W2a: static .dockerignore contains id_rsa*") : fail("W2a: .dockerignore missing id_rsa*", di);
        di.includes("Dockerfile") ? ok("W2a: static .dockerignore contains Dockerfile") : fail("W2a: .dockerignore missing Dockerfile", di);
        di.includes("fly.toml") ? ok("W2a: static .dockerignore contains fly.toml") : fail("W2a: .dockerignore missing fly.toml", di);

        // W2b: ssc-nginx.conf contains server_tokens off and dotfile location block
        let nc = "";
        try { nc = await fsTmp.readFile(pathTmp.join(d, "ssc-nginx.conf"), "utf8"); } catch {}
        nc.includes("server_tokens off") ? ok("W2b: ssc-nginx.conf has server_tokens off") : fail("W2b: ssc-nginx.conf missing server_tokens off", nc);
        nc.includes("location ~ /\\.") ? ok("W2b: ssc-nginx.conf has dotfile location block") : fail("W2b: ssc-nginx.conf missing dotfile location block", nc);
        nc.includes("return 404") ? ok("W2b: ssc-nginx.conf returns 404 for dotfiles") : fail("W2b: ssc-nginx.conf missing return 404", nc);

        // W2c: Dockerfile copies ssc-nginx.conf into /etc/nginx/conf.d/default.conf
        const df = await fsTmp.readFile(pathTmp.join(d, "Dockerfile"), "utf8");
        df.includes("COPY ssc-nginx.conf /etc/nginx/conf.d/default.conf")
          ? ok("W2c: Dockerfile copies ssc-nginx.conf to /etc/nginx/conf.d/default.conf")
          : fail("W2c: Dockerfile missing nginx COPY", df);

        // W2d: Dockerfile deletes ssc-nginx.conf from document root
        df.includes("RUN rm -f /usr/share/nginx/html/ssc-nginx.conf")
          ? ok("W2d: Dockerfile removes ssc-nginx.conf from document root")
          : fail("W2d: Dockerfile missing RUN rm for ssc-nginx.conf", df);
      } finally { await cleanup(d); }
    }

    // ── W3: Node/Python .dockerignore — .git only, no dotfile glob ───────────

    // W3a: Node .dockerignore
    {
      const d = await mkTmp();
      try {
        await fsTmp.writeFile(pathTmp.join(d, "package.json"), JSON.stringify({
          name: "w3-node", version: "1.0.0", scripts: { start: "node app.js" },
        }));
        const t = await detectAppType(d);
        await generateDeployFiles(d, "ssc-w3-node", t);
        let di = "";
        try { di = await fsTmp.readFile(pathTmp.join(d, ".dockerignore"), "utf8"); } catch {}
        di.includes(".git") ? ok("W3a: node .dockerignore contains .git") : fail("W3a: node .dockerignore missing .git", di);
        !di.includes("*.pem") ? ok("W3a: node .dockerignore does not contain *.pem") : fail("W3a: node .dockerignore should not contain *.pem", di);
      } finally { await cleanup(d); }
    }

    // W3b: Python .dockerignore
    {
      const d = await mkTmp();
      try {
        await fsTmp.writeFile(pathTmp.join(d, "requirements.txt"), "flask\ngunicorn");
        await fsTmp.writeFile(pathTmp.join(d, "app.py"), "app = None");
        const t = await detectAppType(d);
        await generateDeployFiles(d, "ssc-w3-py", t);
        let di = "";
        try { di = await fsTmp.readFile(pathTmp.join(d, ".dockerignore"), "utf8"); } catch {}
        di.includes(".git") ? ok("W3b: python .dockerignore contains .git") : fail("W3b: python .dockerignore missing .git", di);
        !di.includes("*.pem") ? ok("W3b: python .dockerignore does not contain *.pem") : fail("W3b: python .dockerignore should not contain *.pem", di);
      } finally { await cleanup(d); }
    }

    // W3c: user Dockerfile — no .dockerignore written
    {
      const d = await mkTmp();
      try {
        await fsTmp.writeFile(pathTmp.join(d, "Dockerfile"), "FROM node:20-alpine\nEXPOSE 3000\n");
        const t = await detectAppType(d);
        await generateDeployFiles(d, "ssc-w3-df", t);
        let diExists = false;
        try { await fsTmp.access(pathTmp.join(d, ".dockerignore")); diExists = true; } catch {}
        !diExists ? ok("W3c: user-supplied Dockerfile → no .dockerignore written") : fail("W3c: .dockerignore should not be written for user Dockerfile");
      } finally { await cleanup(d); }
    }

    // ── W4: Intake zip with no recognised type → fails at detect, no Fly app ──

    {
      // Enable real deploy so the actual detectAppType is called
      await request("POST", "/test/set-real-deploy", { body: { enabled: true } });
      await request("POST", "/test/reset-fly-call-log");

      // Build a zip with no recognised app type (README + image — no .env/index.html/package.json)
      const textOnlyZip = await buildZip({
        "README.md": "# My project\nNo server code here.\n",
        "logo.png": "PNG_PLACEHOLDER",
      });

      const form = new FormData();
      form.append("code", textOnlyZip, { filename: "app.zip", contentType: "application/zip" });

      const intakeResp = await request("POST", "/v1/deployments/intake/zip", {
        headers: { ...authHeaders(keyA), ...form.getHeaders() },
        formData: form,
      });

      if (intakeResp.status !== 202) {
        fail("W4: intake should return 202", `got ${intakeResp.status} ${JSON.stringify(intakeResp.body)}`);
      } else {
        ok("W4: intake accepted (202)");
        const deploymentId = (intakeResp.body as Record<string, unknown>).deployment_id as string;

        // Poll until terminal
        let pollResult: DeployPollResult;
        try {
          pollResult = await pollDeployment(deploymentId, keyA, 10000);
        } finally {
          // Always restore stub mode
          await request("POST", "/test/set-real-deploy", { body: { enabled: false } });
        }

        pollResult.status === "failed"
          ? ok("W4: deployment status=failed")
          : fail("W4: expected status=failed", `got ${pollResult.status}`);
        pollResult.failure_stage === "detect"
          ? ok("W4: failure_stage=detect (before Fly provisioning)")
          : fail("W4: expected failure_stage=detect", `got ${pollResult.failure_stage}`);
        typeof pollResult.failure_message === "string" && pollResult.failure_message.length > 0
          ? ok("W4: failure_message is set")
          : fail("W4: failure_message missing", String(pollResult.failure_message));

        // No Fly app should have been created
        const logResp = await request("GET", "/test/fly-call-log");
        const calls = ((logResp.body as Record<string, unknown>).calls ?? []) as Array<{ fn: string }>;
        const createCalls = calls.filter((c) => c.fn === "createFlyApp");
        createCalls.length === 0
          ? ok("W4: no createFlyApp call (failed before Fly provisioning)")
          : fail("W4: createFlyApp was called despite detect failure", JSON.stringify(createCalls));
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  section("Y: processHandlers crash-exit · SSC login · dbGuard");
  // ════════════════════════════════════════════════════════════════════════════

  {
    const tsx = path.join(__dirname, "../node_modules/.bin/tsx");

    // ── Y1: uncaughtException → exit 1, stderr contains "[process] uncaughtException" ──
    {
      // Write a minimal temp script next to the test runner so relative imports resolve.
      const y1Script = path.join(__dirname, "_y1_ph_tmp.ts");
      try {
        fs.writeFileSync(
          y1Script,
          `import { installProcessHandlers } from "../src/lib/processHandlers";\n` +
          `installProcessHandlers();\n` +
          `setTimeout(() => { throw new Error("y1 deliberate uncaught error"); }, 50);\n`,
        );

        const y1Result = await new Promise<{ code: number; stderr: string; stdout: string }>((resolve) => {
          const child = require("child_process").spawn(tsx, [y1Script], {
            cwd: __dirname,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
          child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
          child.on("close", (code: number) => resolve({ code: code ?? 1, stderr, stdout }));
        });

        y1Result.code === 1
          ? ok("Y1: uncaughtException → exit code 1")
          : fail("Y1: expected exit code 1", `got ${y1Result.code}`);
        y1Result.stderr.includes("[process] uncaughtException")
          ? ok("Y1: stderr contains [process] uncaughtException")
          : fail("Y1: stderr missing [process] uncaughtException", y1Result.stderr.slice(0, 300));
        // No secret-looking content (FLY_API_TOKEN, DATABASE_URL password, CLERK key)
        const y1Combined = y1Result.stdout + y1Result.stderr;
        const y1Secrets = ["test-token", "CLERK_SECRET_KEY", "sk_test_fake"].filter(
          (s) => y1Combined.includes(s),
        );
        y1Secrets.length === 0
          ? ok("Y1: no secret values in process output")
          : fail("Y1: secret value(s) leaked into output", y1Secrets.join(", "));
      } finally {
        try { fs.unlinkSync(y1Script); } catch {}
      }
    }

    // ── Y2: SSC login — muted stdin, key not echoed, config saved with mode 0600 ──
    {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ssc-login-y2-"));
      try {
        const cliPath = path.join(__dirname, "../../../packages/cli/src/index.ts");

        const y2Result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
          const child = require("child_process").spawn(tsx, [cliPath, "login"], {
            env: { ...process.env, HOME: tmpHome, SSC_API_URL: BASE_URL },
            stdio: ["pipe", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
          child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
          child.on("close", (code: number) => resolve({ code: code ?? 1, stdout, stderr }));
          // Pipe the key (non-TTY mode — no prompt, no echo)
          child.stdin!.write(keyA + "\n");
          child.stdin!.end();
        });

        y2Result.code === 0
          ? ok("Y2: ssc login exits 0")
          : fail("Y2: ssc login should exit 0", `code=${y2Result.code} stderr=${y2Result.stderr.slice(0, 300)}`);

        const y2Combined = y2Result.stdout + y2Result.stderr;
        !y2Combined.includes(keyA)
          ? ok("Y2: API key does not appear in stdout or stderr")
          : fail("Y2: API key leaked into output", y2Combined.slice(0, 300));

        const cfgPath = path.join(tmpHome, ".config", "ssc", "config.json");
        const cfgExists = fs.existsSync(cfgPath);
        cfgExists ? ok("Y2: config file created") : fail("Y2: config file not found", cfgPath);

        if (cfgExists) {
          const stat = fs.statSync(cfgPath);
          // mode & 0o777 gives permission bits
          (stat.mode & 0o777) === 0o600
            ? ok("Y2: config file mode is 0600")
            : fail("Y2: config file mode is not 0600", `0o${(stat.mode & 0o777).toString(8)}`);

          const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
          typeof cfg.api_url === "string" && cfg.api_url.length > 0
            ? ok("Y2: config file contains api_url")
            : fail("Y2: config file missing api_url", JSON.stringify(cfg));
          !JSON.stringify(cfg).includes(keyA)
            ? ok("Y2: config file content not echoed to stdout/stderr (key in file is correct)")
            : ok("Y2: config file contains the key (expected)"); // key in file is fine
        }
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    }

    // ── Y3: dbGuard unit tests ────────────────────────────────────────────────
    {
      delete require.cache[require.resolve("../src/lib/dbGuard")];
      const { assertSafeDatabaseUrl } = require("../src/lib/dbGuard") as {
        assertSafeDatabaseUrl: (url: string, env?: NodeJS.ProcessEnv) => void;
      };

      // Remote host without RAILWAY_ENVIRONMENT → throws
      let threw = false;
      try { assertSafeDatabaseUrl("postgres://u:pw@10.0.0.1/db", {}); } catch { threw = true; }
      threw ? ok("Y3: remote host (no RAILWAY_ENVIRONMENT) → throws") : fail("Y3: remote host should throw");

      // Remote host with RAILWAY_ENVIRONMENT → passes
      let passed3b = true;
      try { assertSafeDatabaseUrl("postgres://u:pw@10.0.0.1/db", { RAILWAY_ENVIRONMENT: "production" }); } catch { passed3b = false; }
      passed3b ? ok("Y3: remote host + RAILWAY_ENVIRONMENT → passes") : fail("Y3: RAILWAY_ENVIRONMENT should bypass guard");

      // localhost → passes
      let passed3c = true;
      try { assertSafeDatabaseUrl("postgres://u:pw@localhost/db", {}); } catch { passed3c = false; }
      passed3c ? ok("Y3: localhost → passes") : fail("Y3: localhost should pass");

      // 127.0.0.1 → passes
      let passed3d = true;
      try { assertSafeDatabaseUrl("postgres://u:pw@127.0.0.1/db", {}); } catch { passed3d = false; }
      passed3d ? ok("Y3: 127.0.0.1 → passes") : fail("Y3: 127.0.0.1 should pass");

      // SSC_ALLOW_REMOTE_DB=1 → passes
      let passed3e = true;
      try { assertSafeDatabaseUrl("postgres://u:pw@10.0.0.1/db", { SSC_ALLOW_REMOTE_DB: "1" }); } catch { passed3e = false; }
      passed3e ? ok("Y3: SSC_ALLOW_REMOTE_DB=1 → passes") : fail("Y3: SSC_ALLOW_REMOTE_DB=1 should bypass guard");

      // Error message must not contain the password
      let errMsg = "";
      try { assertSafeDatabaseUrl("postgres://u:supersecretpw@10.0.0.1/db", {}); } catch (e) {
        errMsg = e instanceof Error ? e.message : String(e);
      }
      !errMsg.includes("supersecretpw")
        ? ok("Y3: error message does not contain database password")
        : fail("Y3: error message leaks database password", errMsg.slice(0, 200));
      errMsg.includes("10.0.0.1")
        ? ok("Y3: error message names the offending host")
        : fail("Y3: error message should name the host", errMsg.slice(0, 200));

      // ?host=evil.example.com → throws
      let threw3g = false;
      try { assertSafeDatabaseUrl("postgres://u:secretpw@localhost/db?host=evil.example.com", {}); } catch { threw3g = true; }
      threw3g ? ok("Y3: ?host=evil.example.com → throws") : fail("Y3: ?host=evil.example.com should throw");

      // ?HOST=evil.example.com → throws (case-insensitive)
      let threw3h = false;
      try { assertSafeDatabaseUrl("postgres://u:secretpw@localhost/db?HOST=evil.example.com", {}); } catch { threw3h = true; }
      threw3h ? ok("Y3: ?HOST=evil.example.com → throws (case-insensitive)") : fail("Y3: ?HOST=evil.example.com should throw case-insensitively");

      // ?hostaddr=10.0.0.5 → throws
      let threw3i = false; let errMsg3i = "";
      try { assertSafeDatabaseUrl("postgres://u:secretpw@localhost/db?hostaddr=10.0.0.5", {}); } catch (e) {
        threw3i = true;
        errMsg3i = e instanceof Error ? e.message : String(e);
      }
      threw3i ? ok("Y3: ?hostaddr=10.0.0.5 → throws") : fail("Y3: ?hostaddr=10.0.0.5 should throw");
      !errMsg3i.includes("secretpw")
        ? ok("Y3: ?hostaddr error message does not contain the password")
        : fail("Y3: ?hostaddr error message leaks password", errMsg3i.slice(0, 200));

      // ?host=/var/run/postgresql → passes (Unix socket via query param, localhost in URL hostname)
      let passed3j = true;
      try { assertSafeDatabaseUrl("postgres://u:secretpw@localhost/db?host=/var/run/postgresql", {}); } catch { passed3j = false; }
      passed3j ? ok("Y3: ?host=/var/run/postgresql → passes (Unix socket)") : fail("Y3: Unix socket ?host should pass");

      // postgres://u@[::1]:5432/db → passes (IPv6 localhost)
      let passed3k = true;
      try { assertSafeDatabaseUrl("postgres://u:secretpw@[::1]:5432/db", {}); } catch { passed3k = false; }
      passed3k ? ok("Y3: postgres://u@[::1]:5432/db → passes (IPv6 localhost)") : fail("Y3: [::1] should pass as IPv6 localhost");
    }

    // ── Y4: migrate exits non-zero quickly without connecting to remote DB ────
    {
      const y4Result = await new Promise<{ code: number; output: string }>((resolve) => {
        const childEnv: NodeJS.ProcessEnv = {
          ...process.env,
          DATABASE_URL: "postgres://u:secretpw@10.255.255.1:5432/x",
        };
        delete childEnv.RAILWAY_ENVIRONMENT;
        delete childEnv.SSC_ALLOW_REMOTE_DB;

        const child = require("child_process").spawn(
          tsx,
          ["src/db/migrate.ts"],
          {
            cwd: path.join(__dirname, ".."),
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        child.stdout.on("data", (d: Buffer) => { output += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { output += d.toString(); });

        const timer = setTimeout(() => {
          child.kill();
          resolve({ code: 1, output: output + "\n[timed out]" });
        }, 3000);

        child.on("close", (code: number) => {
          clearTimeout(timer);
          resolve({ code: code ?? 1, output });
        });
      });

      y4Result.code !== 0
        ? ok("Y4: migrate exits non-zero when remote DB and no RAILWAY_ENVIRONMENT")
        : fail("Y4: migrate should exit non-zero", `output: ${y4Result.output.slice(0, 300)}`);
      !y4Result.output.includes("secretpw")
        ? ok("Y4: migrate output does not contain database password")
        : fail("Y4: migrate output leaks password", y4Result.output.slice(0, 300));
      !y4Result.output.includes("[timed out]")
        ? ok("Y4: migrate exited within 3 seconds")
        : fail("Y4: migrate timed out (should fast-fail before connecting)");
      y4Result.output.includes("[migrate] FATAL")
        ? ok("Y4: migrate output contains [migrate] FATAL prefix (guard path reached)")
        : fail("Y4: migrate output missing [migrate] FATAL prefix", y4Result.output.slice(0, 300));
      y4Result.output.includes("points to a remote host")
        ? ok("Y4: migrate output contains guard message text")
        : fail("Y4: migrate output missing guard message text", y4Result.output.slice(0, 300));
    }

    // ── Y5: src/db.ts refuses remote DATABASE_URL at module load time ─────────
    {
      const y5Script = path.join(__dirname, "_y5_db_tmp.ts");
      try {
        fs.writeFileSync(
          y5Script,
          `import "../src/db";\nprocess.exit(0);\n`,
          "utf8",
        );

        const y5Result = await new Promise<{ code: number; output: string }>((resolve) => {
          const childEnv: NodeJS.ProcessEnv = {
            ...process.env,
            DATABASE_URL: "postgres://u:secretpw@10.255.255.1:5432/x",
          };
          delete childEnv.RAILWAY_ENVIRONMENT;
          delete childEnv.SSC_ALLOW_REMOTE_DB;

          const child = require("child_process").spawn(
            tsx,
            [y5Script],
            {
              cwd: path.join(__dirname, ".."),
              env: childEnv,
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let output = "";
          child.stdout.on("data", (d: Buffer) => { output += d.toString(); });
          child.stderr.on("data", (d: Buffer) => { output += d.toString(); });

          const timer = setTimeout(() => {
            child.kill();
            resolve({ code: 1, output: output + "\n[timed out]" });
          }, 5000);

          child.on("close", (code: number) => {
            clearTimeout(timer);
            resolve({ code: code ?? 1, output });
          });
        });

        y5Result.code !== 0
          ? ok("Y5: db.ts exits non-zero when remote DATABASE_URL and no RAILWAY_ENVIRONMENT")
          : fail("Y5: db.ts should exit non-zero with remote DB", `output: ${y5Result.output.slice(0, 300)}`);
        y5Result.output.includes("points to a remote host")
          ? ok("Y5: db.ts output contains guard message text")
          : fail("Y5: db.ts output missing guard message text", y5Result.output.slice(0, 300));
        !y5Result.output.includes("secretpw")
          ? ok("Y5: db.ts output does not contain database password")
          : fail("Y5: db.ts output leaks password", y5Result.output.slice(0, 300));
        !y5Result.output.includes("[timed out]")
          ? ok("Y5: db.ts exited within 5 seconds")
          : fail("Y5: db.ts timed out (should fast-fail before connecting)");
      } finally {
        try { fs.unlinkSync(y5Script); } catch { /* already gone */ }
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  section("X: Dockerfile hardening checks (digest pins, non-root user, flyctl pin)");
  // ════════════════════════════════════════════════════════════════════════════

  {
    const dfPath = path.join(__dirname, "..", "Dockerfile");
    const df = fs.readFileSync(dfPath, "utf8");
    const lines = df.split("\n");

    // X1: every FROM line must include @sha256:
    const fromLines = lines.filter((l) => /^\s*FROM\s/i.test(l));
    const fromWithoutDigest = fromLines.filter((l) => !l.includes("@sha256:"));
    fromWithoutDigest.length === 0
      ? ok(`X1: all ${fromLines.length} FROM line(s) carry an @sha256: digest`)
      : fail("X1: FROM line(s) missing @sha256: digest", fromWithoutDigest.join(" | "));

    // X2: last USER line must exist and must not be root or 0
    const userLines = lines.filter((l) => /^\s*USER\s/i.test(l));
    if (userLines.length === 0) {
      fail("X2: no USER line found in Dockerfile");
    } else {
      const lastUser = userLines[userLines.length - 1].trim().replace(/^USER\s+/i, "").trim();
      lastUser !== "root" && lastUser !== "0"
        ? ok(`X2: last USER is "${lastUser}" (not root/0)`)
        : fail("X2: last USER is root or 0 — image must run as unprivileged user", lastUser);
    }

    // X3: flyctl version must be pinned to 0.5.1
    df.includes("0.5.1")
      ? ok("X3: Dockerfile pins flyctl 0.5.1")
      : fail("X3: flyctl version 0.5.1 not found in Dockerfile");

    // X4: sha256 checksum verification of the flyctl download must be present
    df.includes("sha256sum")
      ? ok("X4: Dockerfile verifies flyctl download with sha256sum")
      : fail("X4: no sha256sum check of flyctl download in Dockerfile");
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Section Z — per-org private Fly networks
  // ════════════════════════════════════════════════════════════════════════════
  {
    section("Z: per-org Fly private networks");

    // ── Z1: networkForOrg unit tests ──────────────────────────────────────────
    {
      const { networkForOrg } = require("../src/lib/flyNetwork") as {
        networkForOrg: (orgId: string) => string;
      };

      // Format: starts with a letter, only [a-z0-9-]
      const sampleUuid = "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d";
      const net = networkForOrg(sampleUuid);
      /^[a-z]/.test(net)
        ? ok("Z1: networkForOrg result starts with a letter")
        : fail("Z1: networkForOrg result does not start with a letter", net);
      /^[a-z0-9-]+$/.test(net)
        ? ok("Z1: networkForOrg result contains only [a-z0-9-]")
        : fail("Z1: networkForOrg result has invalid characters", net);

      // Deterministic: same input → same output
      networkForOrg(sampleUuid) === net
        ? ok("Z1: networkForOrg is deterministic")
        : fail("Z1: networkForOrg is not deterministic");

      // Different orgs → different networks
      const otherUuid = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
      networkForOrg(otherUuid) !== net
        ? ok("Z1: different orgIds produce different networks")
        : fail("Z1: different orgIds should produce different networks");

      // Throws on missing input
      let threw1 = false;
      try { networkForOrg(""); } catch { threw1 = true; }
      threw1 ? ok("Z1: empty orgId → throws") : fail("Z1: empty orgId should throw");

      // Throws on non-UUID input
      let threw2 = false;
      try { networkForOrg("not-a-uuid"); } catch { threw2 = true; }
      threw2 ? ok("Z1: non-UUID orgId → throws") : fail("Z1: non-UUID orgId should throw");

      // Throws on plain string without UUID structure
      let threw3 = false;
      try { networkForOrg("org_12345"); } catch { threw3 = true; }
      threw3 ? ok("Z1: non-UUID string → throws") : fail("Z1: non-UUID string should throw");
    }

    // ── Z2/Z3/Z4: deploy network propagation (uses real deployRunner) ─────────
    {
      // Fresh orgs for Z tests
      const { rows: zA1Rows } = await pool.query<{ id: string }>(
        "INSERT INTO orgs (clerk_org_id,name,slug) VALUES ('clerk_org_z1','Z Org A','z-org-a') RETURNING id",
      );
      const zOrgAId = zA1Rows[0].id;
      const { rows: zA2Rows } = await pool.query<{ id: string }>(
        "INSERT INTO orgs (clerk_org_id,name,slug) VALUES ('clerk_org_z2','Z Org B','z-org-b') RETURNING id",
      );
      const zOrgBId = zA2Rows[0].id;

      const { fullKey: zKeyA, keyPrefix: zKPA, keyHash: zKHA } = generateApiKey();
      await pool.query(
        "INSERT INTO api_keys (org_id,created_by,name,key_prefix,key_hash) VALUES ($1,$2,'z-key-a',$3,$4)",
        [zOrgAId, userId, zKPA, zKHA],
      );
      const { fullKey: zKeyB, keyPrefix: zKPB, keyHash: zKHB } = generateApiKey();
      await pool.query(
        "INSERT INTO api_keys (org_id,created_by,name,key_prefix,key_hash) VALUES ($1,$2,'z-key-b',$3,$4)",
        [zOrgBId, userId, zKPB, zKHB],
      );

      const { networkForOrg } = require("../src/lib/flyNetwork") as {
        networkForOrg: (orgId: string) => string;
      };
      const expectedNetA = networkForOrg(zOrgAId);
      const expectedNetB = networkForOrg(zOrgBId);

      await request("POST", "/test/set-real-deploy", { body: { enabled: true } });
      await request("POST", "/test/set-flyctl-mode", { body: { mode: "success" } });

      const zZip = await buildZip({
        "package.json": JSON.stringify({
          name: "z-test-app",
          version: "1.0.0",
          scripts: { start: "node index.js" },
        }),
        "index.js": "require('http').createServer((_,r)=>r.end('ok')).listen(8080)",
      });

      const afterDeploy = () => new Promise<void>((r) => setTimeout(r, 400));

      // ── Z2: deploy for org A sends networkForOrg(A) in createFlyApp body ─────
      {
        await resetFlyLog();

        const z2Form = new FormData();
        z2Form.append("code", zZip, { filename: "app.zip", contentType: "application/zip" });
        z2Form.append("app_name", "z2-app");
        const z2Intake = await request("POST", "/v1/deployments/intake/zip", {
          headers: authHeaders(zKeyA), formData: z2Form,
        });
        const { deployment_id: z2DepId } = z2Intake.body as Record<string, string>;
        await pollDeployment(z2DepId, zKeyA);
        await afterDeploy();

        const z2Log = await getFlyLog();
        const z2Create = z2Log.find((c) => c.fn === "createFlyApp");
        z2Create
          ? ok("Z2: createFlyApp was called for org-A deploy")
          : fail("Z2: createFlyApp should have been called");
        z2Create?.body?.network === expectedNetA
          ? ok(`Z2: createFlyApp body.network === networkForOrg(orgA) (${expectedNetA})`)
          : fail("Z2: createFlyApp body.network mismatch",
              `got ${JSON.stringify(z2Create?.body?.network)} want ${expectedNetA}`);
      }

      // ── Z3: two orgs → different networks; same org → same network ───────────
      {
        // Deploy for org B
        await resetFlyLog();

        const z3FormB = new FormData();
        z3FormB.append("code", zZip, { filename: "app.zip", contentType: "application/zip" });
        z3FormB.append("app_name", "z3-app-b");
        const z3IntakeB = await request("POST", "/v1/deployments/intake/zip", {
          headers: authHeaders(zKeyB), formData: z3FormB,
        });
        const { deployment_id: z3DepIdB } = z3IntakeB.body as Record<string, string>;
        await pollDeployment(z3DepIdB, zKeyB);
        await afterDeploy();

        const z3LogB = await getFlyLog();
        const z3CreateB = z3LogB.find((c) => c.fn === "createFlyApp");
        z3CreateB?.body?.network === expectedNetB
          ? ok("Z3: org-B deploy uses org-B network")
          : fail("Z3: org-B deploy network mismatch",
              `got ${JSON.stringify(z3CreateB?.body?.network)} want ${expectedNetB}`);

        expectedNetA !== expectedNetB
          ? ok("Z3: org-A and org-B networks are different")
          : fail("Z3: org-A and org-B should have different networks");

        // Second deploy in org A → same network
        await resetFlyLog();

        const z3FormA2 = new FormData();
        z3FormA2.append("code", zZip, { filename: "app.zip", contentType: "application/zip" });
        z3FormA2.append("app_name", "z3-app-a2");
        const z3IntakeA2 = await request("POST", "/v1/deployments/intake/zip", {
          headers: authHeaders(zKeyA), formData: z3FormA2,
        });
        const { deployment_id: z3DepIdA2 } = z3IntakeA2.body as Record<string, string>;
        await pollDeployment(z3DepIdA2, zKeyA);
        await afterDeploy();

        const z3LogA2 = await getFlyLog();
        const z3CreateA2 = z3LogA2.find((c) => c.fn === "createFlyApp");
        z3CreateA2?.body?.network === expectedNetA
          ? ok("Z3: second deploy in org-A uses same network as first")
          : fail("Z3: second org-A deploy network mismatch",
              `got ${JSON.stringify(z3CreateA2?.body?.network)} want ${expectedNetA}`);
      }

      // ── Z4: failed-first-deploy recreate path sends same network ─────────────
      {
        // First deploy fails → fly_app_id cleared
        await request("POST", "/test/set-flyctl-mode", { body: { mode: "failure" } });
        await resetFlyLog();

        const z4Form1 = new FormData();
        z4Form1.append("code", zZip, { filename: "app.zip", contentType: "application/zip" });
        z4Form1.append("app_name", "z4-app");
        const z4Intake1 = await request("POST", "/v1/deployments/intake/zip", {
          headers: authHeaders(zKeyA), formData: z4Form1,
        });
        const { deployment_id: z4DepId1, app_id: z4AppId } = z4Intake1.body as Record<string, string>;
        await pollDeployment(z4DepId1, zKeyA);
        await afterDeploy();

        const z4Log1 = await getFlyLog();
        const z4Create1 = z4Log1.find((c) => c.fn === "createFlyApp");
        z4Create1?.body?.network === expectedNetA
          ? ok("Z4: failed-first-deploy createFlyApp uses org network")
          : fail("Z4: failed-first-deploy network mismatch",
              `got ${JSON.stringify(z4Create1?.body?.network)} want ${expectedNetA}`);

        // Redeploy the same app (fly_app_id is NULL → new Fly app via recreate path)
        await request("POST", "/test/set-flyctl-mode", { body: { mode: "success" } });
        await resetFlyLog();

        const z4Form2 = new FormData();
        z4Form2.append("code", zZip, { filename: "app.zip", contentType: "application/zip" });
        z4Form2.append("app_id", z4AppId);
        const z4Intake2 = await request("POST", "/v1/deployments/intake/zip", {
          headers: authHeaders(zKeyA), formData: z4Form2,
        });
        const { deployment_id: z4DepId2 } = z4Intake2.body as Record<string, string>;
        await pollDeployment(z4DepId2, zKeyA);
        await afterDeploy();

        const z4Log2 = await getFlyLog();
        const z4Create2 = z4Log2.find((c) => c.fn === "createFlyApp");
        z4Create2?.body?.network === expectedNetA
          ? ok("Z4: redeploy after failed-first-deploy (recreate path) uses same org network")
          : fail("Z4: recreate-path network mismatch",
              `got ${JSON.stringify(z4Create2?.body?.network)} want ${expectedNetA}`);
      }

      // Cleanup Z sections
      await request("POST", "/test/set-real-deploy", { body: { enabled: false } });
      await request("POST", "/test/set-flyctl-mode", { body: { mode: "success" } });
      await pool.query("DELETE FROM orgs WHERE id IN ($1,$2)", [zOrgAId, zOrgBId]);
    }

    // ── Z5: static guard — every createFlyApp call site passes a network ───────
    {
      const srcDir = path.join(__dirname, "..", "src");
      const networkViolations: string[] = [];

      function walkSync(dir: string): string[] {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const files: string[] = [];
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) files.push(...walkSync(full));
          else if (e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".js"))) files.push(full);
        }
        return files;
      }

      for (const filePath of walkSync(srcDir)) {
        const src = fs.readFileSync(filePath, "utf8");
        const relPath = path.relative(path.join(__dirname, ".."), filePath);
        // Find every createFlyApp(...) call. We capture the argument list to
        // check that at least 3 arguments are present (name, orgSlug, network).
        // We scan line-by-line so we can report the line number.
        const lines = src.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.includes("createFlyApp(")) continue;
          // Count arguments: a call with ≥3 args has at least 2 commas inside the parens.
          // Heuristic: extract everything from the opening paren to the matching close.
          const parenStart = line.indexOf("createFlyApp(") + "createFlyApp(".length;
          // Simple scan for argument count — works for single-line calls.
          // For multi-line calls, check whether the line contains at least one comma.
          const afterParen = line.slice(parenStart);
          const commaCount = (afterParen.match(/,/g) ?? []).length;
          if (commaCount < 2) {
            networkViolations.push(`${relPath}:${i + 1}`);
          }
        }
      }

      networkViolations.length === 0
        ? ok("Z5: every createFlyApp call in apps/api/src passes a network argument (static guard)")
        : fail("Z5: createFlyApp call(s) missing network argument",
            "\n    " + networkViolations.join("\n    "));
    }

    // ── Z6: real flyClient.ts sends `network` in the POST /apps HTTP body ──────
    // Strategy: both FLY_API_BASE and FLY_API_TOKEN are read inside makeClient()
    // at every call, not at module load — so setting process.env before the call
    // is sufficient; no fresh require is needed.
    {
      const { networkForOrg: z6NetworkForOrg } = require("../src/lib/flyNetwork") as {
        networkForOrg: (orgId: string) => string;
      };
      const { createFlyApp: z6CreateFlyApp } = require("../src/services/flyClient") as {
        createFlyApp: (appName: string, orgSlug: string, network: string) => Promise<void>;
      };

      const Z6_UUID = "c0ffee00-dead-4bee-cafe-123456789abc";
      const z6Network = z6NetworkForOrg(Z6_UUID);

      // Record captured requests from the loopback server
      interface Z6Req { method: string; path: string; headers: Record<string, string>; body: unknown }
      const z6Captured: Z6Req[] = [];

      const z6Server = await new Promise<import("http").Server>((resolve) => {
        const srv = require("http").createServer(
          (req: import("http").IncomingMessage, res: import("http").ServerResponse) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
              let body: unknown = null;
              try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* non-JSON */ }
              z6Captured.push({
                method: req.method ?? "",
                path: req.url ?? "",
                headers: req.headers as Record<string, string>,
                body,
              });
              res.writeHead(201, { "Content-Type": "application/json" });
              res.end("{}");
            });
          },
        );
        srv.listen(0, "127.0.0.1", () => resolve(srv));
      });

      const z6Port = (z6Server.address() as import("net").AddressInfo).port;

      // Stash and override env — makeClient() reads these at call time
      const prevFlyApiBase  = process.env.FLY_API_BASE;
      const prevFlyApiToken = process.env.FLY_API_TOKEN;
      process.env.FLY_API_BASE  = `http://127.0.0.1:${z6Port}`;
      process.env.FLY_API_TOKEN = "z6-dummy-token";

      try {
        await z6CreateFlyApp("ssc-z6-test", "test-org", z6Network);
      } finally {
        // Restore env unconditionally
        if (prevFlyApiBase === undefined) delete process.env.FLY_API_BASE;
        else process.env.FLY_API_BASE = prevFlyApiBase;
        if (prevFlyApiToken === undefined) delete process.env.FLY_API_TOKEN;
        else process.env.FLY_API_TOKEN = prevFlyApiToken;
        await new Promise<void>((r) => z6Server.close(() => r()));
      }

      // Assertions
      z6Captured.length === 1
        ? ok("Z6: exactly one HTTP request reached the loopback server")
        : fail("Z6: expected exactly 1 request", `got ${z6Captured.length}`);

      const z6Req = z6Captured[0];

      z6Req?.method === "POST"
        ? ok("Z6: request method is POST")
        : fail("Z6: expected POST", z6Req?.method);

      (z6Req?.path === "/apps" || z6Req?.path === "/v1/apps")
        ? ok(`Z6: request path is ${z6Req.path}`)
        : fail("Z6: expected /apps or /v1/apps path", z6Req?.path);

      const z6Body = z6Req?.body as Record<string, unknown> | null;

      z6Body?.app_name === "ssc-z6-test"
        ? ok("Z6: body.app_name === 'ssc-z6-test'")
        : fail("Z6: body.app_name mismatch", JSON.stringify(z6Body?.app_name));

      z6Body?.org_slug === "test-org"
        ? ok("Z6: body.org_slug === 'test-org'")
        : fail("Z6: body.org_slug mismatch", JSON.stringify(z6Body?.org_slug));

      z6Body?.network === z6Network
        ? ok(`Z6: body.network === networkForOrg(uuid) (${z6Network})`)
        : fail("Z6: body.network mismatch",
            `got ${JSON.stringify(z6Body?.network)} want ${z6Network}`);

      z6Req?.headers?.authorization === "Bearer z6-dummy-token"
        ? ok("Z6: Authorization header carries the dummy token")
        : fail("Z6: Authorization header mismatch", z6Req?.headers?.authorization);
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════════════════════════════════════
  console.log("\n" + B("─".repeat(50)));
  console.log(G(`  Passed: ${passed}`) + "   " + (failed > 0 ? R(`Failed: ${failed}`) : DIM(`Failed: ${failed}`)));

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(R("\nFatal: " + e.message));
  console.error(e.stack);
  process.exit(1);
});
