export type DeployStatus =
  | "queued"
  | "building"
  | "deploying"
  | "success"
  | "failed"
  | "cancelled";

export type AppStatus =
  | "pending"
  | "building"
  | "running"
  | "stopped"
  | "failed"
  | "sleeping";

export interface App {
  id: string;
  name: string;
  slug: string;
  source_type: string | null;
  source_ref: string | null;
  fly_app_id: string | null;
  subdomain: string | null;
  created_at: string;
  suspended: boolean;
  status: AppStatus;
  latest_deployment_status: DeployStatus | null;
  last_deployed_at: string | null;
}

export interface Deployment {
  id: string;
  status: DeployStatus;
  version: number;
  started_at: string | null;
  finished_at: string | null;
  failure_stage: string | null;
  failure_message: string | null;
}

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes?: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ApiKeyCreated extends ApiKey {
  key: string;
}

export interface AppAccess {
  email: string;
  display_name: string | null;
  granted_at: string;
  status: "active" | "pending";
}
