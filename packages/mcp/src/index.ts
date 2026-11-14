#!/usr/bin/env node
/**
 * SSC MCP stdio server.
 *
 * Exposes two tools:
 *   deploy_app            — zip a local dir or submit a GitHub URL
 *   get_deployment_status — poll a deployment
 *
 * Register in Claude Code:
 *   {
 *     "mcpServers": {
 *       "ssc": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/packages/mcp/dist/index.js"],
 *         "env": {
 *           "SSC_API_KEY": "ssc_...",
 *           "SSC_API_URL": "https://api.smallsoftware.cloud"
 *         }
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { SscClient } from "@ssc/client";
import type { DeployEvent } from "@ssc/client";

// ─── Per-process deploy rate limit ────────────────────────────────────────────
// Guards against an agent loop that calls deploy_app in a tight retry loop and
// runs up the bill.  Exported so tests can inspect and reset the state.

export const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
export const RATE_MAX_CALLS = 5;
export const deployCallTimestamps: number[] = [];

export function checkRateLimit(): { allowed: boolean; message?: string } {
  const now = Date.now();
  // Drop timestamps that have aged out of the rolling window
  while (
    deployCallTimestamps.length > 0 &&
    deployCallTimestamps[0] < now - RATE_WINDOW_MS
  ) {
    deployCallTimestamps.shift();
  }
  if (deployCallTimestamps.length >= RATE_MAX_CALLS) {
    const resetInMs = deployCallTimestamps[0] + RATE_WINDOW_MS - now;
    const resetInSec = Math.ceil(resetInMs / 1000);
    return {
      allowed: false,
      message:
        `Rate limit exceeded: deploy_app may be called at most ${RATE_MAX_CALLS} times ` +
        `per 10 minutes per process. Resets in ~${resetInSec}s. ` +
        `Stop retrying and tell the user — do not loop.`,
    };
  }
  deployCallTimestamps.push(now);
  return { allowed: true };
}

// ─── Server factory ───────────────────────────────────────────────────────────
// Exported so tests can create an in-process server without connecting stdio.

export function createServer(): McpServer {
  const server = new McpServer({
    name: "ssc",
    version: "0.1.0",
  });

  // ── deploy_app ──────────────────────────────────────────────────────────────

  server.registerTool(
    "deploy_app",
    {
      description: `Deploy an application to Small Software Cloud from a local directory or a GitHub URL.

RESULT — SUCCESS: returns deployment_id, app_id, status="success", url.
RESULT — FAILURE: returns deployment_id, app_id, status="failed", failure_stage, failure_message, and the last 20 log lines. Read them to diagnose the problem before retrying.

IMPORTANT — app_id:
  The first deploy creates a new app and returns its app_id.
  ALWAYS save the app_id and pass it as app_id on every subsequent deploy of the same app.
  If you omit app_id a brand-new app is created and billed separately — do not do this.

AFTER A FAILURE:
  1. Read failure_stage, failure_message, and the last log lines to understand what went wrong.
  2. Fix the code in the local directory.
  3. Call deploy_app again with the same app_id and the corrected local_path.
  4. Do NOT omit app_id and create a new app unless the user explicitly asks for a different app.
  5. Do NOT retry more than 3 times without pausing to ask the user for guidance.

REFUSED INPUTS (returns an error without uploading anything):
  • The user's home directory or filesystem root — too dangerous to zip.
  • Any directory with no project marker (package.json, requirements.txt, Dockerfile, index.html, etc.).

FILES NEVER UPLOADED: .env, .env.*, *.key, *.pem, node_modules/, .git/ — always excluded from the zip.`,
      inputSchema: z.object({
        local_path: z
          .string()
          .optional()
          .describe("Absolute path to a local directory to zip and deploy"),
        github_url: z
          .string()
          .optional()
          .describe(
            "Public GitHub HTTPS URL (e.g. https://github.com/owner/repo)",
          ),
        app_id: z
          .string()
          .optional()
          .describe(
            "Existing app ID for redeployment. Save from the first deploy and reuse on every later deploy — omitting it creates a new app.",
          ),
        app_name: z
          .string()
          .optional()
          .describe(
            "Human-readable name for a new app (ignored when app_id is provided)",
          ),
      }),
    },
    async (input) => {
      // Per-process rate limit guard — must be first
      const rateCheck = checkRateLimit();
      if (!rateCheck.allowed) {
        return {
          content: [{ type: "text" as const, text: rateCheck.message! }],
          isError: true,
        };
      }

      const { local_path, github_url, app_id, app_name } = input;

      if (!local_path && !github_url) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: provide either local_path or github_url",
            },
          ],
          isError: true,
        };
      }
      if (local_path && github_url) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: local_path and github_url are mutually exclusive",
            },
          ],
          isError: true,
        };
      }

      const client = new SscClient();
      const opts = {
        ...(app_id ? { appId: app_id } : {}),
        ...(app_name ? { appName: app_name } : {}),
      };

      let deploymentId: string;
      let appId: string;

      try {
        if (github_url) {
          ({ deployment_id: deploymentId, app_id: appId } =
            await client.deployGithub(github_url, opts));
        } else {
          ({ deployment_id: deploymentId, app_id: appId } =
            await client.deployZip(local_path!, opts));
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Deploy submission failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }

      // Stream logs — keep only the last 20 lines to avoid bloating the context window
      const recentLogs: string[] = [];
      const MAX_LOG_LINES = 20;
      let appUrl: string | null = null;
      let failed = false;
      let finalStatus = "unknown";
      let failureStage: string | null = null;
      let failureMessage: string | null = null;

      try {
        await client.streamDeployment(deploymentId, (event: DeployEvent) => {
          switch (event.type) {
            case "log":
              recentLogs.push(event.message);
              if (recentLogs.length > MAX_LOG_LINES) recentLogs.shift();
              break;
            case "status":
              finalStatus = event.status;
              if (event.status === "failed") failed = true;
              break;
            case "url":
              appUrl = event.url;
              break;
            case "error":
              failureStage = event.stage;
              failureMessage = event.message;
              failed = true;
              break;
            case "done":
              break;
          }
        });
      } catch (err) {
        failureMessage = `Stream error: ${err instanceof Error ? err.message : String(err)}`;
        failureStage = failureStage ?? "stream";
        if (finalStatus === "unknown") finalStatus = "failed";
        failed = true;
      }

      if (failed) {
        // Failure result: always include stage, message, and last log lines
        const lines: string[] = [
          `deployment_id: ${deploymentId}`,
          `app_id: ${appId}`,
          `status: ${finalStatus}`,
          `failure_stage: ${failureStage ?? "unknown"}`,
          `failure_message: ${failureMessage ?? "unknown"}`,
        ];
        if (recentLogs.length > 0) {
          lines.push("");
          lines.push("Last log lines:");
          for (const line of recentLogs) {
            lines.push(`  ${line}`);
          }
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          isError: true,
        };
      }

      // Success result: short
      const lines: string[] = [
        `deployment_id: ${deploymentId}`,
        `app_id: ${appId}`,
        `status: ${finalStatus}`,
      ];
      if (appUrl) lines.push(`url: ${appUrl}`);
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        isError: false,
      };
    },
  );

  // ── delete_app ───────────────────────────────────────────────────────────────

  server.registerTool(
    "delete_app",
    {
      description: `Permanently deletes an app and its Fly.io resources. This cannot be undone.

Only call this when the user has explicitly asked to delete this specific app.
Pass the app's exact current name as confirm_name; the call is refused if it does not match.`,
      inputSchema: z.object({
        app_id: z.string().describe("The ID of the app to delete"),
        confirm_name: z
          .string()
          .describe(
            "The app's exact current name — must match exactly (case-sensitive) or the deletion is refused",
          ),
      }),
    },
    async (input) => {
      const { app_id, confirm_name } = input;
      const client = new SscClient();

      let app: Awaited<ReturnType<typeof client.getApp>>;
      try {
        app = await client.getApp(app_id);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: err instanceof Error ? err.message : String(err),
            },
          ],
          isError: true,
        };
      }

      if (confirm_name !== app.name) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Confirmation name does not match the app's name; nothing was deleted.",
            },
          ],
          isError: true,
        };
      }

      try {
        await client.deleteApp(app_id);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: err instanceof Error ? err.message : String(err),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `Deleted ${app.name}.` }],
        isError: false,
      };
    },
  );

  // ── get_deployment_status ────────────────────────────────────────────────────

  server.registerTool(
    "get_deployment_status",
    {
      description: `Get the current status of a deployment by its deployment_id (returned by deploy_app).

Returns a JSON object with:
  - status: "queued" | "building" | "deploying" | "success" | "failed"
  - url: the live URL (only present when status is "success")
  - failure_stage, failure_message: why it failed (only present when status is "failed")
  - started_at, finished_at: ISO timestamps

Use this to poll a deployment still in progress, or to re-read failure details without re-running the deploy.`,
      inputSchema: z.object({
        deployment_id: z
          .string()
          .describe("The deployment_id returned by deploy_app"),
      }),
    },
    async (input) => {
      const client = new SscClient();
      try {
        const deployment = await client.getDeployment(input.deployment_id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(deployment, null, 2),
            },
          ],
          isError: deployment.status === "failed",
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[mcp] fatal:", err);
    process.exit(1);
  });
}
