import type { AppStatus, DeployStatus } from "./api-types";

export type ResolvedStatus =
  | "Suspended"
  | "Deploying"
  | "Failed"
  | "Live"
  | "Sleeping";

/**
 * Derive the user-visible status from the three API fields.
 *
 * Priority order:
 *  1. Suspended  — suspended=true trumps everything
 *  2. Deploying  — an in-progress deployment
 *  3. Failed     — latest deployment failed, or app status is failed
 *  4. Sleeping   — app status is sleeping
 *  5. Live       — otherwise (running + success, or pending with no deploy yet)
 */
export function resolveAppStatus(
  suspended: boolean,
  appStatus: AppStatus,
  latestDeployStatus: DeployStatus | null,
): ResolvedStatus {
  if (suspended) return "Suspended";
  if (
    latestDeployStatus === "queued" ||
    latestDeployStatus === "building" ||
    latestDeployStatus === "deploying"
  ) {
    return "Deploying";
  }
  if (latestDeployStatus === "failed" || appStatus === "failed") return "Failed";
  if (appStatus === "sleeping") return "Sleeping";
  return "Live";
}

const FAILURE_STAGE_COPY: Record<string, string> = {
  clone: "Failed to clone repository",
  extract: "Failed to extract uploaded archive",
  detect: "Could not detect runtime",
  config: "Invalid configuration",
  fly_app: "Failed to create cloud app",
  build: "Build failed",
  deploy: "Deployment failed",
};

export function deploymentFailureTitle(stage: string | null): string {
  if (!stage) return "Deployment failed";
  return FAILURE_STAGE_COPY[stage] ?? "Deployment failed";
}
