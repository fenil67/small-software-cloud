/**
 * Watchdog: proxy health probe + abuse metrics.
 *
 * runProbeRound()   — probes every eligible app's /__ssc/health and /
 * runMetricsRound() — queries Fly Prometheus for per-app CPU + egress abuse
 *
 * validateWatchdogConfig() — called at startup from index.ts; validates
 *   ALERT_DISCORD_WEBHOOK_URL, WATCHDOG_CPU_CORES, WATCHDOG_EGRESS_BYTES_PER_SEC.
 *
 * Both rounds are scheduled by reaper.ts (never by this module).
 * Timers must NOT be started here — reaper.ts owns the schedule.
 */

import http from "http";
import https from "https";
import { pool } from "../db";
import { safeErr } from "./safeErr";
import { recordAlert } from "./alerts";
import { queryCpuMetrics, queryEgressMetrics, type MetricSample } from "./flyMetrics";
import { listMachines, destroyMachine, checkFlyAppExists } from "../services/flyClient";

// ── Startup validation ────────────────────────────────────────────────────────

/**
 * Called at startup (from index.ts after all imports).
 * Validates watchdog-related env vars; exits 1 with a specific message on
 * any violation.  Never prints the URL value in error messages.
 */
export function validateWatchdogConfig(): void {
  // ALERT_DISCORD_WEBHOOK_URL — optional; if set, must be a Discord webhook HTTPS URL
  // (http://localhost is also allowed when SSC_TEST=1)
  const webhookUrl = process.env.ALERT_DISCORD_WEBHOOK_URL;
  if (webhookUrl) {
    let parsed: URL;
    try {
      parsed = new URL(webhookUrl);
    } catch {
      console.error(
        "[startup] FATAL: ALERT_DISCORD_WEBHOOK_URL is not a valid URL.",
      );
      process.exit(1);
    }

    const isTest = process.env.SSC_TEST === "1";
    const isLoopback =
      parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    const isDiscordHttps =
      parsed.protocol === "https:" &&
      (webhookUrl.startsWith("https://discord.com/api/webhooks/") ||
        webhookUrl.startsWith("https://discordapp.com/api/webhooks/"));
    const isTestLocalHttp =
      isTest && parsed.protocol === "http:" && isLoopback;

    if (!isDiscordHttps && !isTestLocalHttp) {
      console.error(
        "[startup] FATAL: ALERT_DISCORD_WEBHOOK_URL must start with " +
          "https://discord.com/api/webhooks/ or https://discordapp.com/api/webhooks/ " +
          "(http://localhost is allowed when SSC_TEST=1).",
      );
      process.exit(1);
    }
  }

  // WATCHDOG_CPU_CORES — positive number, default 0.8
  const cpuRaw = process.env.WATCHDOG_CPU_CORES ?? "0.8";
  const cpuVal = parseFloat(cpuRaw);
  if (!isFinite(cpuVal) || cpuVal <= 0) {
    console.error(
      "[startup] FATAL: WATCHDOG_CPU_CORES must be a positive number.",
    );
    process.exit(1);
  }

  // WATCHDOG_EGRESS_BYTES_PER_SEC — positive number, default 1000000
  const egressRaw = process.env.WATCHDOG_EGRESS_BYTES_PER_SEC ?? "1000000";
  const egressVal = parseFloat(egressRaw);
  if (!isFinite(egressVal) || egressVal <= 0) {
    console.error(
      "[startup] FATAL: WATCHDOG_EGRESS_BYTES_PER_SEC must be a positive number.",
    );
    process.exit(1);
  }

  // WATCHDOG_PROBE_SECONDS — optional integer, 30–3600
  const probeSecRaw = process.env.WATCHDOG_PROBE_SECONDS;
  if (probeSecRaw !== undefined) {
    const probeVal = parseInt(probeSecRaw, 10);
    if (!Number.isInteger(probeVal) || String(probeVal) !== probeSecRaw.trim() || probeVal < 30 || probeVal > 3600) {
      console.error(
        "[startup] FATAL: WATCHDOG_PROBE_SECONDS must be an integer between 30 and 3600.",
      );
      process.exit(1);
    }
  }
}

// ── Test-only probe base URL overrides ────────────────────────────────────────
// When SSC_TEST=1, the probe base URL per fly_app_id can be overridden so
// tests can point probes at a local test server instead of fly.dev.

const _testProbeBaseUrls = new Map<string, string>();

/** Only usable when SSC_TEST=1. Sets the probe base URL for one fly_app_id. */
export function _setTestProbeBaseUrl(flyAppId: string, baseUrl: string): void {
  _testProbeBaseUrls.set(flyAppId, baseUrl);
}

/** Clears all test probe URL overrides. */
export function _clearTestProbeBaseUrls(): void {
  _testProbeBaseUrls.clear();
}

function probeBaseUrl(flyAppId: string): string {
  if (process.env.SSC_TEST === "1") {
    const override = _testProbeBaseUrls.get(flyAppId);
    if (override) return override;
  }
  return `https://${flyAppId}.fly.dev`;
}

// ── Shared suspend function ───────────────────────────────────────────────────

/**
 * Suspends an app via the same DB path as the admin kill switch:
 *   - UPDATE apps SET suspended_at, suspended_by=null, suspend_reason
 *   - INSERT admin_audit with actor_clerk_user_id="system:watchdog"
 *   - Force-destroys all Fly machines (failures are silent)
 *
 * Never throws — errors are logged and the function returns normally.
 */
export async function suspendAppByWatchdog(
  appId: string,
  flyAppId: string | null,
  reason: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE apps
       SET suspended_at = now(), suspended_by = NULL, suspend_reason = $1
       WHERE id = $2`,
      [reason, appId],
    );
    await client.query(
      `INSERT INTO admin_audit
         (action, app_id, actor_user_id, actor_clerk_user_id, reason)
       VALUES ('suspend', $1, NULL, 'system:watchdog', $2)`,
      [appId, reason],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[watchdog] suspendApp DB error:", safeErr(err));
    return;
  } finally {
    client.release();
  }

  // Force-destroy every machine; individual failures are silent
  if (flyAppId) {
    try {
      const machines = await listMachines(flyAppId);
      await Promise.all(
        machines.map(async (m) => {
          try {
            await destroyMachine(flyAppId, m.id);
          } catch {
            /* ignore per-machine errors */
          }
        }),
      );
    } catch {
      /* ignore list failure */
    }
  }
}

// ── HTTP probe helper ─────────────────────────────────────────────────────────

interface PathResult {
  statusCode: number | null; // null = connection error or timeout
  hasProxyHeader: boolean;
  location: string | null;
}

/**
 * Makes a single GET request to url.
 * Does NOT follow redirects (node's http does not follow by default).
 * 10 s timeout.  Returns PathResult — never throws.
 */
function probePath(url: string): Promise<PathResult> {
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { resolve({ statusCode: null, hasProxyHeader: false, location: null }); return; }

    const isHttps = parsed.protocol === "https:";
    const lib: typeof http | typeof https = isHttps ? https : http;
    const port = parsed.port
      ? parseInt(parsed.port, 10)
      : (isHttps ? 443 : 80);

    const req = lib.get(
      {
        hostname: parsed.hostname,
        port,
        path: parsed.pathname + (parsed.search ?? ""),
        headers: { Accept: "text/html" },
      },
      (res) => {
        res.resume(); // drain body without reading
        resolve({
          statusCode: res.statusCode ?? null,
          hasProxyHeader: res.headers["x-ssc-proxy"] === "1",
          location: (res.headers.location as string | undefined) ?? null,
        });
      },
    );

    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ statusCode: null, hasProxyHeader: false, location: null });
    });
    req.on("error", () =>
      resolve({ statusCode: null, hasProxyHeader: false, location: null }),
    );
  });
}

// ── Probe classification ──────────────────────────────────────────────────────

type ClassifyResult =
  | { verdict: "healthy" }
  | { verdict: "exposed"; reason: string }
  | { verdict: "unreachable" };

/**
 * Classifies a pair of probe results.  EXPOSED always wins over UNREACHABLE:
 * if either endpoint returned an HTTP response that is not the expected proxy
 * response (and is not a 5xx-from-the-edge), the app is considered EXPOSED
 * regardless of what the other endpoint returned.
 *
 * "Answered without protection" for a path:
 *   statusCode is not null
 *   AND NOT (5xx without proxy header = Fly-edge error → treated as unreachable)
 *   AND NOT the correct proxy response for that path
 *
 * Precedence:
 *   1. EXPOSED   — either path answered without protection
 *   2. UNREACHABLE — either path is null (timeout/conn-error) or 5xx without proxy
 *   3. HEALTHY   — both paths returned the expected proxy response
 */
export function classifyProbe(
  appId: string,
  webUrl: string,
  health: PathResult,
  root: PathResult,
): ClassifyResult {
  // ── Edge-5xx flags (not our proxy, treated as unreachable) ───────────────
  const healthIsEdge5xx =
    health.statusCode !== null &&
    health.statusCode >= 500 &&
    !health.hasProxyHeader;
  const rootIsEdge5xx =
    root.statusCode !== null &&
    root.statusCode >= 500 &&
    !root.hasProxyHeader;

  // ── Correct-response flags ────────────────────────────────────────────────
  const healthCorrect = health.statusCode === 200 && health.hasProxyHeader;

  const correctLocation =
    typeof root.location === "string" &&
    root.location.startsWith(`${webUrl}/access?app=${appId}`);
  const rootCorrect =
    root.statusCode === 302 && root.hasProxyHeader && correctLocation;

  // ── "Answered without protection" ────────────────────────────────────────
  // Got a response that is neither an edge-5xx nor the correct proxy response.
  const healthAnsweredWithoutProtection =
    health.statusCode !== null && !healthIsEdge5xx && !healthCorrect;
  const rootAnsweredWithoutProtection =
    root.statusCode !== null && !rootIsEdge5xx && !rootCorrect;

  // 1. EXPOSED takes priority — security must win over availability
  if (healthAnsweredWithoutProtection || rootAnsweredWithoutProtection) {
    const reason = healthAnsweredWithoutProtection
      ? (health.hasProxyHeader
          ? "health endpoint returned unexpected response"
          : "health endpoint answered without proxy header")
      : (root.hasProxyHeader
          ? "root endpoint gave wrong redirect"
          : "root endpoint answered without proxy header");
    return { verdict: "exposed", reason };
  }

  // 2. UNREACHABLE — timeout, conn-error, or Fly-edge 5xx on either path
  const healthUnreachable = health.statusCode === null || healthIsEdge5xx;
  const rootUnreachable   = root.statusCode   === null || rootIsEdge5xx;
  if (healthUnreachable || rootUnreachable) return { verdict: "unreachable" };

  // 3. HEALTHY — both paths returned the expected proxy response
  return { verdict: "healthy" };
}

// ── Probe round ───────────────────────────────────────────────────────────────

type ProbeableApp = {
  id: string;
  name: string;
  fly_app_id: string;
  consecutive_unreachable: number;
};

async function probeOneApp(
  app: ProbeableApp,
  webUrl: string,
): Promise<void> {
  const base = probeBaseUrl(app.fly_app_id);
  const healthResult = await probePath(`${base}/__ssc/health`);
  const rootResult = await probePath(`${base}/`);

  const verdict = classifyProbe(app.id, webUrl, healthResult, rootResult);

  // Update probe state: last_probe_at always; consecutive_unreachable on UNREACHABLE or reset
  await pool.query(
    `INSERT INTO watchdog_probe_state (app_id, consecutive_unreachable, last_probe_at)
     VALUES ($1, $2, now())
     ON CONFLICT (app_id) DO UPDATE
       SET last_probe_at = now(),
           consecutive_unreachable = $2`,
    [
      app.id,
      verdict.verdict === "unreachable"
        ? app.consecutive_unreachable + 1
        : 0,
    ],
  ).catch(() => {});

  if (verdict.verdict === "healthy") {
    return; // nothing to do
  }

  if (verdict.verdict === "unreachable") {
    // Check whether the Fly app still exists before counting as unreachable.
    // If Fly returns 404, the app was deleted externally: clear fly_app_id,
    // fire a one-time alert, and do not count this round as an unreachable hit.
    // If the existence check itself fails (network/5xx), treat as plain unreachable.
    let appExists: boolean;
    try {
      appExists = await checkFlyAppExists(app.fly_app_id);
    } catch {
      appExists = true; // cannot determine — treat as plain unreachable
    }

    if (!appExists) {
      await pool.query(
        "UPDATE apps SET fly_app_id = NULL WHERE id = $1",
        [app.id],
      ).catch(() => {});
      await pool.query(
        "DELETE FROM watchdog_probe_state WHERE app_id = $1",
        [app.id],
      ).catch(() => {});
      await recordAlert("fly_app_missing", app.id, {
        message: `Fly app ${app.fly_app_id} no longer exists`,
        fly_app_id: app.fly_app_id,
      });
      return;
    }

    const newCount = app.consecutive_unreachable + 1;
    // Alert only at exactly 3 consecutive unreachable
    if (newCount === 3) {
      await recordAlert("app_unreachable", app.id, {
        message: `app ${app.name} is unreachable (3 consecutive failures)`,
        fly_app_id: app.fly_app_id,
      });
    }
    return;
  }

  // EXPOSED — suspend immediately
  const suspendReason = "watchdog: app answered without the access proxy";
  await suspendAppByWatchdog(app.id, app.fly_app_id, suspendReason);
  await recordAlert("app_exposed_suspended", app.id, {
    message: verdict.reason,
    fly_app_id: app.fly_app_id,
  });
}

/** Runs at most `limit` probes concurrently. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const run = async (): Promise<void> => {
    while (idx < items.length) {
      const i = idx++;
      try {
        await fn(items[i]);
      } catch {
        /* one app failure must not stop the loop */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/**
 * Probes every eligible app:
 *   - not deleted (deleted_at IS NULL)
 *   - not suspended (suspended_at IS NULL)
 *   - has a fly_app_id
 *   - latest deployment is 'success'
 *
 * Concurrency limit: 5.
 */
export async function runProbeRound(): Promise<void> {
  const webUrl = process.env.WEB_URL ?? "";

  let apps: ProbeableApp[];
  try {
    const { rows } = await pool.query<ProbeableApp>(`
      SELECT
        a.id,
        a.name,
        a.fly_app_id,
        COALESCE(wps.consecutive_unreachable, 0) AS consecutive_unreachable
      FROM apps a
      LEFT JOIN watchdog_probe_state wps ON wps.app_id = a.id
      WHERE a.deleted_at IS NULL
        AND a.suspended_at IS NULL
        AND a.fly_app_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM deployments d
          WHERE d.app_id = a.id
            AND d.status = 'success'
          ORDER BY d.created_at DESC
          LIMIT 1
        )
    `);
    apps = rows;
  } catch (err) {
    console.error("[watchdog] runProbeRound DB error:", safeErr(err));
    return;
  }

  if (apps.length === 0) return;

  await runWithConcurrency(apps, 5, (app) => probeOneApp(app, webUrl));
}

// ── Metrics helpers ───────────────────────────────────────────────────────────

/**
 * Extracts a short, safe reason string from a metrics query error.
 * Returns the Node.js error code if present, otherwise the first 60 chars of
 * the error message.  Never includes URLs, tokens, or full error objects.
 */
function metricsErrReason(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ?? err.message.slice(0, 60);
  }
  return String(err).slice(0, 60);
}

// ── Metrics round ─────────────────────────────────────────────────────────────

/**
 * Queries Fly Prometheus for CPU + egress, and fires alerts for apps that exceed
 * configured thresholds.  Only apps in our `apps` table (matched by fly_app_id)
 * are considered; unknown apps (e.g. ssc-proxy-image) are silently ignored.
 *
 * Thresholds:
 *   WATCHDOG_CPU_CORES         (default 0.8)
 *   WATCHDOG_EGRESS_BYTES_PER_SEC (default 1_000_000)
 *
 * Never suspends for metrics violations.
 */
export async function runMetricsRound(): Promise<void> {
  const cpuThreshold = parseFloat(
    process.env.WATCHDOG_CPU_CORES ?? "0.8",
  );
  const egressThreshold = parseFloat(
    process.env.WATCHDOG_EGRESS_BYTES_PER_SEC ?? "1000000",
  );

  // Build a lookup map: fly_app_id → { appId, name }
  let appMap: Map<string, { id: string; name: string }>;
  try {
    const { rows } = await pool.query<{
      id: string;
      name: string;
      fly_app_id: string;
    }>(
      `SELECT id, name, fly_app_id FROM apps
       WHERE deleted_at IS NULL AND fly_app_id IS NOT NULL`,
    );
    appMap = new Map(rows.map((r) => [r.fly_app_id, { id: r.id, name: r.name }]));
  } catch (err) {
    console.error("[watchdog] runMetricsRound DB error:", safeErr(err));
    return;
  }

  // ── CPU ────────────────────────────────────────────────────────────────────
  let cpuSamples: MetricSample[] = [];
  let cpuError = false;
  let cpuErrReason = "";
  try {
    cpuSamples = await queryCpuMetrics();
  } catch (err) {
    cpuError = true;
    cpuErrReason = metricsErrReason(err);
    // safeErr scrubs any tokens; never log the error object directly.
    console.error("[watchdog] CPU metrics query failed:", safeErr(err));
  }

  for (const { flyAppId, value } of cpuSamples) {
    const app = appMap.get(flyAppId);
    if (!app) continue; // not one of ours
    if (value > cpuThreshold) {
      await recordAlert("cpu_high", app.id, {
        message: `CPU ${value.toFixed(3)} cores exceeds threshold ${cpuThreshold}`,
        fly_app_id: flyAppId,
        value,
        threshold: cpuThreshold,
      });
    }
  }

  // ── Egress ─────────────────────────────────────────────────────────────────
  let egressSamples: MetricSample[] = [];
  let egressError = false;
  let egressErrReason = "";
  try {
    egressSamples = await queryEgressMetrics();
  } catch (err) {
    egressError = true;
    egressErrReason = metricsErrReason(err);
    console.error("[watchdog] egress metrics query failed:", safeErr(err));
  }

  for (const { flyAppId, value } of egressSamples) {
    const app = appMap.get(flyAppId);
    if (!app) continue;
    if (value > egressThreshold) {
      await recordAlert("egress_high", app.id, {
        message: `Egress ${value.toFixed(0)} bytes/s exceeds threshold ${egressThreshold}`,
        fly_app_id: flyAppId,
        value,
        threshold: egressThreshold,
      });
    }
  }

  // ── metrics_unavailable ────────────────────────────────────────────────────
  if (cpuError || egressError) {
    const parts = [
      cpuError    ? `cpu: ${cpuErrReason}`    : "",
      egressError ? `egress: ${egressErrReason}` : "",
    ].filter(Boolean);
    await recordAlert("metrics_unavailable", null, {
      reason: parts.join("; "),
    });
  }
}
