#!/usr/bin/env node
/**
 * SSC MCP stdio server.
 *
 * Exposes two tools:
 *   deploy_app            — zip a local dir or submit a GitHub URL
 *   get_deployment_status — poll or stream a deployment
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

const server = new McpServer({
  name: "ssc",
  version: "0.1.0",
});

// ─── deploy_app ───────────────────────────────────────────────────────────────

server.registerTool(
  "deploy_app",
  {
    description:
      "Deploy an application to Small Software Cloud. " +
      "Provide either a local_path (absolute path to a directory) or a github_url " +
      "(public GitHub HTTPS URL). Optionally pass app_id to redeploy an existing app. " +
      "Returns the deployment ID and a stream of log events.",
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
        .describe("Existing app ID for redeployment"),
      app_name: z
        .string()
        .optional()
        .describe("Human-readable name for a new app"),
    }),
  },
  async (input) => {
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

    // Stream logs — keep only the last 20 log lines to avoid bloating the context window
    const recentLogs: string[] = [];
    let appUrl: string | null = null;
    let failed = false;
    let finalStatus: string = "unknown";
    let failureStage: string | null = null;
    let failureMessage: string | null = null;

    const MAX_LOG_LINES = 20;

    try {
      await client.streamDeployment(deploymentId, (event: DeployEvent) => {
        switch (event.type) {
          case "log":
            recentLogs.push(event.message);
            if (recentLogs.length > MAX_LOG_LINES) recentLogs.shift();
            break;
          case "status":
            finalStatus = event.status;
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
      failed = true;
    }

    // Build a concise result
    const resultLines: string[] = [];
    resultLines.push(`deployment_id: ${deploymentId}`);
    resultLines.push(`app_id: ${appId}`);
    resultLines.push(`status: ${finalStatus}`);

    if (appUrl) {
      resultLines.push(`url: ${appUrl}`);
    }

    if (failed) {
      if (failureStage) resultLines.push(`failure_stage: ${failureStage}`);
      if (failureMessage) resultLines.push(`failure_message: ${failureMessage}`);
      if (recentLogs.length > 0) {
        resultLines.push("");
        resultLines.push("Last log lines:");
        for (const line of recentLogs) {
          resultLines.push(`  ${line}`);
        }
      }
    }

    return {
      content: [{ type: "text" as const, text: resultLines.join("\n") }],
      isError: failed,
    };
  },
);

// ─── get_deployment_status ────────────────────────────────────────────────────

server.registerTool(
  "get_deployment_status",
  {
    description:
      "Get the current status and metadata for a deployment. " +
      "Returns a JSON object with status, url, failure details, and more.",
    inputSchema: z.object({
      deployment_id: z
        .string()
        .describe("The deployment ID returned by deploy_app"),
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

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[mcp] fatal:", err);
  process.exit(1);
});
