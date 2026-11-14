/**
 * Fly Prometheus metrics client.
 *
 * Queries the per-org Fly Prometheus endpoint for per-app CPU and egress rates.
 * Uses FLY_API_TOKEN (same credential as flyClient) and FLY_ORG_SLUG.
 *
 * FLY_METRICS_BASE overrides the default https://api.fly.io ONLY when the
 * parsed hostname is exactly localhost, 127.0.0.1, or ::1 — same loopback
 * restriction as FLY_API_BASE — to prevent credential forwarding to arbitrary hosts.
 */

import http from "http";
import https from "https";
import { safeErr } from "./safeErr";
import { flyAuthHeader } from "../services/flyClient";

const FLY_METRICS_DEFAULT = "https://api.fly.io";

function resolveMetricsBase(): string {
  const override = process.env.FLY_METRICS_BASE;
  if (!override) return FLY_METRICS_DEFAULT;

  let hostname: string;
  try {
    hostname = new URL(override).hostname;
  } catch {
    return FLY_METRICS_DEFAULT;
  }

  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  ) {
    return override;
  }

  return FLY_METRICS_DEFAULT;
}

export interface MetricSample {
  flyAppId: string;
  value: number;
}

/** GETs a URL with the correct Fly auth header and returns the parsed JSON body. Never throws. */
function httpGetJson(url: string, token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch (e) { reject(e); return; }

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
        headers: {
          Authorization: flyAuthHeader(token),
          Accept: "application/json",
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => {
          // Reject on non-2xx without including the URL or token in the message.
          const status = res.statusCode ?? 0;
          if (status >= 300) {
            reject(new Error(`HTTP ${status}`));
            return;
          }
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error("invalid JSON")); }
        });
      },
    );

    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", reject);
  });
}

/**
 * Executes a PromQL instant query against the Fly Prometheus endpoint for
 * FLY_ORG_SLUG and parses the vector result into MetricSample[].
 * Returns an empty array on any error (caller decides how to handle).
 */
async function queryPrometheus(query: string): Promise<MetricSample[]> {
  const base = resolveMetricsBase();
  const orgSlug = process.env.FLY_ORG_SLUG ?? "";
  const token = process.env.FLY_API_TOKEN ?? "";

  const url =
    `${base}/prometheus/${encodeURIComponent(orgSlug)}/api/v1/query` +
    `?query=${encodeURIComponent(query)}`;

  const raw = await httpGetJson(url, token);

  // Prometheus success response: { status: "success", data: { resultType: "vector", result: [...] } }
  // Any other shape (error body, unexpected format) is treated as a failure.
  const typed = raw as {
    status?: string;
    data?: { result?: Array<{ metric: { app?: string }; value: [number, string] }> };
  };
  if (typed?.status !== "success") {
    throw new Error(`metrics-status=${String(typed?.status ?? "none")}`);
  }
  const result = typed.data?.result;

  if (!Array.isArray(result)) return [];

  return result.flatMap((item) => {
    const flyAppId = item.metric?.app;
    if (!flyAppId) return [];
    const val = parseFloat(item.value[1]);
    if (!isFinite(val)) return [];
    return [{ flyAppId, value: val }];
  });
}

/** Returns per-app CPU rate (cores) over the last 30 minutes. */
export async function queryCpuMetrics(): Promise<MetricSample[]> {
  return queryPrometheus(
    `sum by (app) (rate(fly_instance_cpu{mode=~"user|system"}[30m]))`,
  );
}

/** Returns per-app egress bytes/sec rate over the last 30 minutes. */
export async function queryEgressMetrics(): Promise<MetricSample[]> {
  return queryPrometheus(
    `sum by (app) (rate(fly_instance_net_sent_bytes[30m]))`,
  );
}

/** Exported for tests that need to verify the loopback-only restriction. */
export { resolveMetricsBase, safeErr };
