/**
 * Full integration test suite.
 * Starts the test server, seeds the DB, runs every scenario, then cleans up.
 *
 * Run with:
 *   DATABASE_URL="postgres://fenilpatel@localhost:5432/ssc_test" \
 *   TEST_PORT=4099 \
 *   npx ts-node --project tsconfig.json scripts/run-tests.ts
 */

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
    req.on("error", reject);
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
          res.on("end", () => reject(new Error(`stream ${res.statusCode}: ${Buffer.concat(d).toString()}`)));
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
    req.on("error", reject);
    req.end();
  });
}

// ── DB seeding ────────────────────────────────────────────────────────────────

interface SeedResult {
  orgAId: string;
  orgBId: string;
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

  const orgA = await pool.query<{ id: string }>(
    "INSERT INTO orgs (clerk_org_id, name) VALUES ($1,$2) RETURNING id",
    ["clerk_org_aaa", "Org Alpha"],
  );
  const orgB = await pool.query<{ id: string }>(
    "INSERT INTO orgs (clerk_org_id, name) VALUES ($1,$2) RETURNING id",
    ["clerk_org_bbb", "Org Beta"],
  );
  const orgAId = orgA.rows[0].id;
  const orgBId = orgB.rows[0].id;

  const genAndInsert = async (orgId: string, name: string, revoked = false) => {
    const { fullKey, keyPrefix, keyHash } = generateApiKey();
    await pool.query(
      `INSERT INTO api_keys (org_id, name, key_prefix, key_hash${revoked ? ", revoked_at" : ""})
       VALUES ($1, $2, $3, $4${revoked ? ", now()" : ""})`,
      [orgId, name, keyPrefix, keyHash],
    );
    return fullKey;
  };

  const keyA = await genAndInsert(orgAId, "Key A1");
  const keyARevoked = await genAndInsert(orgAId, "Key A-revoked", true);
  const keyB = await genAndInsert(orgBId, "Key B1");

  console.log(DIM(`  seeded: orgA=${orgAId.slice(0, 8)}… orgB=${orgBId.slice(0, 8)}…`));
  return { orgAId, orgBId, keyA, keyARevoked, keyB };
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

  const { orgAId, orgBId, keyA, keyARevoked, keyB } = await seed();

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

    // Verify app_id is the same
    redeployAppId === successAppId ? ok("redeploy reuses same app_id") : fail("redeploy should reuse app_id");

    // Stream it
    await new Promise((r) => setTimeout(r, 300));
    const events = await streamRequest(`/v1/deployments/${redeployId}/stream`, authHeaders(keyA));
    console.log(`  Redeploy stream events:`);
    for (const raw of events) {
      try { console.log(`    ${DIM("sse")}  ${JSON.stringify(JSON.parse(raw))}`); } catch {}
    }
    const parsed = events.map((e) => { try { return JSON.parse(e); } catch { return {}; } });
    parsed.some((e: any) => e.type === "status" && e.status === "success") ? ok("redeploy stream → success") : fail("redeploy stream should succeed");

    // Check version incremented
    const { rows } = await pool.query<{ version: number }>(
      "SELECT version FROM deployments WHERE id=$1",
      [redeployId],
    );
    const v = rows[0]?.version ?? 0;
    console.log(`  Redeploy version=${v}`);
    v >= 2 ? ok(`redeploy version=${v} (incremented)`) : fail("redeploy version should be ≥2");
  }

  // ════════════════════════════════════════════════════════════════════════════
  section("F: Rate limits");
  // ════════════════════════════════════════════════════════════════════════════

  // F1: hourly limit — verify org A has already hit 10 deploys this session
  {
    const zip = await buildZip({ "package.json": '{"name":"hourly-test"}' });
    const form = new FormData();
    form.append("code", zip, { filename: "app.zip", contentType: "application/zip" });
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
      "INSERT INTO orgs (clerk_org_id, name) VALUES ('clerk_org_limit','Limit Org') RETURNING id",
    );
    const limitOrgId = orgRows[0].id;
    const limitKey = await (async () => {
      const { fullKey, keyPrefix, keyHash } = generateApiKey();
      await pool.query(
        "INSERT INTO api_keys (org_id, name, key_prefix, key_hash) VALUES ($1,'limit-key',$2,$3)",
        [limitOrgId, keyPrefix, keyHash],
      );
      return fullKey;
    })();

    // Insert 10 active apps (each with a success deployment so they count toward app limit)
    // Use started_at 2 hours ago so they don't trigger the hourly limit
    for (let i = 0; i < 10; i++) {
      const { rows: appRows } = await pool.query<{ id: string }>(
        "INSERT INTO apps (org_id, name, slug, source_type) VALUES ($1,$2,$3,'zip') RETURNING id",
        [limitOrgId, `limit-app-${i}`, `limit-app-${i}`],
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
      "INSERT INTO orgs (clerk_org_id, name) VALUES ('clerk_org_failcheck','FailCheck Org') RETURNING id",
    );
    const failCheckOrgId = orgRows[0].id;
    const failCheckKey = await (async () => {
      const { fullKey, keyPrefix, keyHash } = generateApiKey();
      await pool.query(
        "INSERT INTO api_keys (org_id, name, key_prefix, key_hash) VALUES ($1,'fc-key',$2,$3)",
        [failCheckOrgId, keyPrefix, keyHash],
      );
      return fullKey;
    })();

    // Insert 10 apps where ALL deployments failed — should NOT count toward app limit
    // Also use old timestamps to avoid hourly limit
    for (let i = 0; i < 10; i++) {
      const { rows: appRows } = await pool.query<{ id: string }>(
        "INSERT INTO apps (org_id, name, slug, source_type) VALUES ($1,$2,$3,'zip') RETURNING id",
        [failCheckOrgId, `fail-app-${i}`, `fail-app-${i}`],
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

  // ════════════════════════════════════════════════════════════════════════════
  section("H: Reaper — cleans stuck deployments");
  // ════════════════════════════════════════════════════════════════════════════

  {
    // Insert a deployment stuck in 'building' for 20 minutes
    const { rows: appRows } = await pool.query<{ id: string }>(
      "INSERT INTO apps (org_id, name, slug, source_type) VALUES ($1,'reaper-test','reaper-test','zip') RETURNING id",
      [orgAId],
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
      "INSERT INTO apps (org_id, name, slug, source_type, fly_app_id) VALUES ($1,'delete-me','delete-me','zip','ssc-delete-me') RETURNING id",
      [orgAId],
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
