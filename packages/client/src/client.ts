/**
 * SscClient — typed wrapper around the SSC HTTP API.
 *
 * Configuration is resolved from (in order of precedence):
 *   1. Constructor argument
 *   2. SSC_API_KEY / SSC_API_URL env vars
 *   3. ~/.config/ssc/config.json
 */

import fs from "fs";
import path from "path";
import FormData from "form-data";
import axios from "axios";
import { makeAxios, extractErrorMessage, extractSharingError, extractAppError } from "./http";
import { resolveConfig, SscConfig } from "./config";
import { zipDirectory } from "./zip";
import type {
  App,
  Deployment,
  DeploymentSummary,
  BuildLog,
  IntakeResponse,
  DeployOptions,
  DeployEvent,
  AccessList,
  AppEnvVar,
  EnvApplyResult,
} from "./types";

/**
 * Thrown by deployZip / deployGithub when the platform returns 503
 * {"error":"platform_updating"}.  The CLI catches this and retries once after
 * retryAfterSeconds.
 */
export class PlatformUpdatingError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("Utir is updating, try again in a minute");
    this.name = "PlatformUpdatingError";
  }
}

function throwIfPlatformUpdating(err: unknown): void {
  if (axios.isAxiosError(err) && err.response?.status === 503) {
    const body = err.response?.data as Record<string, unknown> | undefined;
    if (body?.error === "platform_updating") {
      const retryAfter = typeof body?.retry_after === "number" ? body.retry_after : 30;
      throw new PlatformUpdatingError(retryAfter);
    }
  }
}

/** Read the "name" field from package.json in dirPath, or return null. */
function readPackageJsonName(dirPath: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dirPath, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { name?: unknown };
    if (typeof pkg.name === "string" && pkg.name) return pkg.name;
  } catch {}
  return null;
}

export class SscClient {
  private config: SscConfig;

  constructor(config?: Partial<SscConfig>) {
    const resolved = resolveConfig();
    this.config = { ...resolved, ...config };
  }

  // ─── Apps ─────────────────────────────────────────────────────────────────

  async getApp(appId: string): Promise<App> {
    const ax = makeAxios(this.config);
    try {
      const { data } = await ax.get<App>(`/v1/apps/${appId}`);
      return data;
    } catch (err) {
      throw new Error(extractAppError(err));
    }
  }

  async deleteApp(appId: string): Promise<void> {
    const ax = makeAxios(this.config);
    try {
      await ax.delete(`/v1/apps/${appId}`);
    } catch (err) {
      throw new Error(extractAppError(err));
    }
  }

  // ─── Auth ──────────────────────────────────────────────────────────────────

  /** Validate the configured API key against the server. Returns the org name. */
  async checkAuth(): Promise<{ org: string }> {
    const ax = makeAxios(this.config);
    try {
      const { data } = await ax.get<{ org: string }>("/v1/auth/check");
      return data;
    } catch (err) {
      throw new Error(extractErrorMessage(err));
    }
  }

  // ─── Deploy ────────────────────────────────────────────────────────────────

  /**
   * Zip a local directory and submit it for deployment.
   * Returns immediately with a deployment ID.
   */
  async deployZip(
    dirPath: string,
    opts: DeployOptions = {},
  ): Promise<IntakeResponse> {
    const zipBuffer = await zipDirectory(dirPath);

    const derivedName =
      opts.appName ??
      readPackageJsonName(dirPath) ??
      path.basename(path.resolve(dirPath));

    const form = new FormData();
    form.append("code", zipBuffer, { filename: "app.zip", contentType: "application/zip" });
    form.append("app_name", derivedName);
    if (opts.appId) form.append("app_id", opts.appId);

    const ax = makeAxios(this.config);
    try {
      const { data } = await ax.post<IntakeResponse>(
        "/v1/deployments/intake/zip",
        form,
        { headers: form.getHeaders(), timeout: 120_000 },
      );
      return data;
    } catch (err) {
      throwIfPlatformUpdating(err);
      throw new Error(extractErrorMessage(err));
    }
  }

  /**
   * Submit a GitHub URL for deployment.
   * Returns immediately with a deployment ID.
   */
  async deployGithub(
    githubUrl: string,
    opts: DeployOptions = {},
  ): Promise<IntakeResponse> {
    // Derive app name from the repo slug in the URL if not provided explicitly
    let repoName: string | undefined;
    try {
      const parts = new URL(githubUrl).pathname.split("/").filter(Boolean);
      if (parts[1]) repoName = parts[1];
    } catch {}
    const derivedName = opts.appName ?? repoName;

    const ax = makeAxios(this.config);
    try {
      const { data } = await ax.post<IntakeResponse>(
        "/v1/deployments/intake/github",
        {
          github_url: githubUrl,
          ...(opts.appId ? { app_id: opts.appId } : {}),
          ...(derivedName ? { app_name: derivedName } : {}),
        },
      );
      return data;
    } catch (err) {
      throwIfPlatformUpdating(err);
      throw new Error(extractErrorMessage(err));
    }
  }

  // ─── Logs ─────────────────────────────────────────────────────────────────

  /** List the last 50 deployments for an app, newest first. */
  async listDeployments(appId: string): Promise<DeploymentSummary[]> {
    const ax = makeAxios(this.config);
    try {
      const { data } = await ax.get<DeploymentSummary[]>(`/v1/apps/${appId}/deployments`);
      return data;
    } catch (err) {
      throw new Error(extractErrorMessage(err));
    }
  }

  /** Fetch the build log for a specific deployment. */
  async getBuildLog(appId: string, deploymentId: string): Promise<BuildLog> {
    const ax = makeAxios(this.config);
    try {
      const { data } = await ax.get<BuildLog>(`/v1/apps/${appId}/deployments/${deploymentId}/logs`);
      return data;
    } catch (err) {
      throw new Error(extractErrorMessage(err));
    }
  }

  // ─── Status ────────────────────────────────────────────────────────────────

  async getDeployment(deploymentId: string): Promise<Deployment> {
    const ax = makeAxios(this.config);
    try {
      const { data } = await ax.get<Deployment>(`/v1/deployments/${deploymentId}`);
      return data;
    } catch (err) {
      throw new Error(extractErrorMessage(err));
    }
  }

  // ─── Sharing ───────────────────────────────────────────────────────────────

  /** Grant access to an app by email. Returns {status:"granted"|"pending"}. */
  async shareApp(appId: string, email: string): Promise<{ status: "granted" | "pending" }> {
    const ax = makeAxios(this.config);
    try {
      const { data } = await ax.post<{ status: "granted" | "pending" }>(
        `/v1/apps/${appId}/access`,
        { email },
      );
      return data;
    } catch (err) {
      throw new Error(extractSharingError(err));
    }
  }

  /** Revoke access to an app by email (removes both app_access and pending rows). */
  async unshareApp(appId: string, email: string): Promise<void> {
    const ax = makeAxios(this.config);
    try {
      await ax.delete(`/v1/apps/${appId}/access/${encodeURIComponent(email)}`);
    } catch (err) {
      throw new Error(extractSharingError(err));
    }
  }

  /** List current users and pending grants for an app. */
  async listAccess(appId: string): Promise<AccessList> {
    const ax = makeAxios(this.config);
    try {
      const { data } = await ax.get<AccessList>(`/v1/apps/${appId}/access`);
      return data;
    } catch (err) {
      throw new Error(extractSharingError(err));
    }
  }

  // ─── Env vars ──────────────────────────────────────────────────────────────

  /** List env variable names for an app (names only, never values). */
  async listEnv(appId: string): Promise<AppEnvVar[]> {
    const ax = makeAxios(this.config);
    try {
      const { data } = await ax.get<AppEnvVar[]>(`/v1/apps/${appId}/env`);
      return data;
    } catch (err) {
      throw new Error(extractErrorMessage(err));
    }
  }

  /** Set or replace an env variable. Value is sent to Fly and never stored in DB. */
  async setEnv(appId: string, name: string, value: string): Promise<void> {
    const ax = makeAxios(this.config);
    try {
      await ax.put(`/v1/apps/${appId}/env`, { name, value });
    } catch (err) {
      throw new Error(extractErrorMessage(err));
    }
  }

  /** Remove an env variable. */
  async unsetEnv(appId: string, name: string): Promise<void> {
    const ax = makeAxios(this.config);
    try {
      await ax.delete(`/v1/apps/${appId}/env/${encodeURIComponent(name)}`);
    } catch (err) {
      throw new Error(extractErrorMessage(err));
    }
  }

  /** Restart app machines so staged env changes take effect. */
  async applyEnv(appId: string): Promise<EnvApplyResult> {
    const ax = makeAxios(this.config);
    try {
      const { data } = await ax.post<EnvApplyResult>(`/v1/apps/${appId}/env/apply`);
      return data;
    } catch (err) {
      throw new Error(extractErrorMessage(err));
    }
  }

  // ─── SSE stream ────────────────────────────────────────────────────────────

  /**
   * Open the SSE stream for a deployment and call onEvent for each event.
   * Resolves when the stream ends (done event or connection closed).
   */
  async streamDeployment(
    deploymentId: string,
    onEvent: (event: DeployEvent) => void,
  ): Promise<void> {
    const ax = makeAxios(this.config);

    // Use responseType: 'stream' to get raw HTTP stream
    const response = await ax.get(
      `/v1/deployments/${deploymentId}/stream`,
      { responseType: "stream", timeout: 0 },
    );

    return new Promise<void>((resolve, reject) => {
      let buffer = "";

      response.data.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice("data: ".length).trim();
          if (!raw) continue;
          try {
            const event = JSON.parse(raw) as DeployEvent;
            onEvent(event);
            if (event.type === "done") {
              resolve();
            }
          } catch {
            // ignore malformed SSE lines
          }
        }
      });

      response.data.on("end", () => resolve());
      response.data.on("error", (err: Error) => reject(err));
    });
  }
}
