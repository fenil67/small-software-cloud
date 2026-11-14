/**
 * Watchdog alert storage + Discord delivery.
 *
 * recordAlert(kind, appId|null, detail)
 *   - Deduplicates: skips insert if same (app_id, kind) exists in the last 6 h.
 *   - If a row is inserted and ALERT_DISCORD_WEBHOOK_URL is configured, POSTs
 *     { content: "..." } with a 5 s timeout and marks delivered=true on 2xx.
 *   - Never throws to the caller.
 *   - Never logs the webhook URL.
 */

import http from "http";
import https from "https";
import { pool } from "../db";
import { safeErr } from "./safeErr";

// ── Discord POST ──────────────────────────────────────────────────────────────

interface DiscordResult {
  delivered: boolean;
  /** Short failure description — status code, "timeout", or Node error code. Never a URL. */
  failReason: string;
}

/**
 * POSTs a JSON payload to webhookUrl.
 * Returns { delivered, failReason } — never throws, never logs the URL.
 * failReason is "status <N>", "timeout", a Node.js error code (e.g. "ECONNREFUSED"),
 * or empty string on success.
 */
function postToDiscord(
  webhookUrl: string,
  body: { content: string },
): Promise<DiscordResult> {
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(webhookUrl); }
    catch { resolve({ delivered: false, failReason: "invalid-url" }); return; }

    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const isHttps = parsed.protocol === "https:";
    const lib: typeof http | typeof https = isHttps ? https : http;
    const port = parsed.port
      ? parseInt(parsed.port, 10)
      : (isHttps ? 443 : 80);

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port,
        path: parsed.pathname + (parsed.search ?? ""),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
        },
      },
      (res) => {
        res.resume(); // drain response body
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          resolve({ delivered: true, failReason: "" });
        } else {
          resolve({ delivered: false, failReason: `status ${status}` });
        }
      },
    );

    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ delivered: false, failReason: "timeout" });
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      resolve({ delivered: false, failReason: err.code ?? "error" });
    });
    req.write(payload);
    req.end();
  });
}

// ── recordAlert ───────────────────────────────────────────────────────────────

/**
 * Inserts a watchdog_alerts row for (kind, appId) unless a matching row already
 * exists within the last 6 hours (deduplication).
 *
 * If a row is inserted and ALERT_DISCORD_WEBHOOK_URL is set, delivers a Discord
 * notification.  On 2xx sets delivered=true in the DB.
 *
 * Never throws.  Logs safe error strings but never the webhook URL or any secret.
 */
export async function recordAlert(
  kind: string,
  appId: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    // ── Deduplication ─────────────────────────────────────────────────────────
    // IS NOT DISTINCT FROM handles NULL correctly (NULL = NULL is not TRUE in SQL).
    const { rowCount: existing } = await pool.query(
      `SELECT 1 FROM watchdog_alerts
       WHERE app_id IS NOT DISTINCT FROM $1::uuid
         AND kind = $2
         AND created_at > now() - INTERVAL '6 hours'
       LIMIT 1`,
      [appId, kind],
    );
    if ((existing ?? 0) > 0) return;

    // ── Insert ─────────────────────────────────────────────────────────────────
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO watchdog_alerts (app_id, kind, detail)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [appId, kind, detail],
    );
    const alertId = rows[0]?.id;
    if (!alertId) return;

    console.log(`[alerts] ${kind} alert stored (id=${alertId})`);

    // ── Discord delivery ───────────────────────────────────────────────────────
    const webhookUrl = process.env.ALERT_DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;

    // Build message text — look up app name + fly_app_id if we have an appId
    let appName = "unknown";
    let flyAppId = "";
    if (appId) {
      try {
        const { rows: appRows } = await pool.query<{
          name: string;
          fly_app_id: string | null;
        }>("SELECT name, fly_app_id FROM apps WHERE id = $1", [appId]);
        if (appRows[0]) {
          appName = appRows[0].name;
          flyAppId = appRows[0].fly_app_id ?? "";
        }
      } catch {
        /* ignore — appName stays "unknown" */
      }
    }

    const flyPart = flyAppId ? ` (${flyAppId})` : "";
    const detailLine =
      typeof detail.message === "string"
        ? detail.message
        : Object.entries(detail)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")
            .slice(0, 120);
    const content = `[SSC] ${kind}: ${appName}${flyPart} ${detailLine}`;

    try {
      const { delivered, failReason } = await postToDiscord(webhookUrl, { content });
      if (delivered) {
        await pool.query(
          "UPDATE watchdog_alerts SET delivered=true WHERE id=$1",
          [alertId],
        );
      } else {
        // Log only the reason code/status — never the URL, error object, or response body.
        console.error(`[alerts] discord delivery failed (${failReason})`);
      }
    } catch {
      // postToDiscord never rejects; this is defence-in-depth.
      console.error("[alerts] discord delivery unexpected error");
    }
  } catch (err) {
    console.error("[alerts] recordAlert failed:", safeErr(err));
  }
}
