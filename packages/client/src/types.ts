export type DeployStatus =
  | "queued"
  | "building"
  | "deploying"
  | "success"
  | "failed";

export interface Deployment {
  id: string;
  app_id: string;
  app_name: string;
  status: DeployStatus;
  version: number;
  started_at: string;
  finished_at: string | null;
  fly_machine_id: string | null;
  failure_stage: string | null;
  failure_message: string | null;
  url: string | null;
  stream_url: string;
}

export interface IntakeResponse {
  deployment_id: string;
  app_id: string;
  stream_url: string;
}

export interface DeployOptions {
  /** Redeploy an existing app by its internal ID. */
  appId?: string;
  /** Human-readable name for a new app (only used when appId is not set). */
  appName?: string;
}

// ─── SSE event types ──────────────────────────────────────────────────────────

export type DeployEvent =
  | { type: "log"; message: string }
  | { type: "status"; status: DeployStatus }
  | { type: "url"; url: string }
  | { type: "error"; stage: string; message: string }
  | { type: "done" };
