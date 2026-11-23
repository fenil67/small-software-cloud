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

// Raw shapes returned by GET /v1/apps/:id/access
export interface AppAccessUser {
  user_id: string;
  email: string;
  granted_at: string;
}

export interface AppPending {
  email: string;
  granted_at: string;
}

export interface AppAccessResponse {
  users: AppAccessUser[];
  pending: AppPending[];
}

// Normalized client shape used by AppDetailClient
export interface AppAccess {
  email: string;
  display_name: string | null;
  granted_at: string;
  status: "active" | "pending";
}

export interface MeResponse {
  is_admin: boolean;
  open_alert_count: number | null;
}

export interface SharedApp {
  app_id: string;
  app_name: string;
  url: string | null;
  org_name: string;
  granted_at: string | null;
  status: 'active' | 'pending';
}

export type EmailInviteStatus =
  | "queued"
  | "disabled"
  | "rate_limited_recipient"
  | "rate_limited_sender"
  | "already_has_access"
  | "invalid_url";

export interface AdminStats {
  people: number;
  people_joined_this_week: number;
  workspaces: number;
  workspaces_with_teammates: number;
  apps: { total: number; live: number; suspended: number };
  deploys_today: { total: number; failed: number };
  visits_today: number;
  refused_today: number;
  watchdog: { apps_checked: number; last_checked_at: string } | null;
  discord_configured: boolean;
  email_sending_configured: boolean;
  deploy_series: Array<{ date: string; succeeded: number; failed: number }>;
  open_alerts: Array<{
    id: string;
    kind: string;
    app_id: string | null;
    app_name: string | null;
    owner_email: string | null;
    created_at: string;
    detail: Record<string, unknown>;
  }>;
}

export interface AdminApp {
  id: string;
  name: string;
  org_id: string;
  fly_app_id: string | null;
  suspended: boolean;
  suspended_at: string | null;
  suspend_reason: string | null;
  owner_email: string | null;
  org_name: string | null;
  last_visit_at: string | null;
  latest_deployment_status: string | null;
  cpu_pct: number | null;
  traffic_bytes_24h: number | null;
}

export interface ActivityEvent {
  id: string;
  event_type: string;
  actor_type: string;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_key_id: string | null;
  org_id: string | null;
  app_id: string | null;
  app_name: string | null;
  target_id: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  occurred_at: string;
  request_id: string | null;
}

export interface ActivityListResponse {
  events: ActivityEvent[];
  next_cursor: string | null;
}

export interface WorkspaceDeletePreview {
  apps: number;
  keys: number;
  pending_invites: number;
}

export interface DeleteMeResponse {
  deleted: boolean;
  clerk_deleted: boolean;
}

export interface DeleteMeBlockedResponse {
  error: "sole_admin_blocked";
  message: string;
  workspaces: Array<{ id: string; name: string }>;
}

export interface ActivitySummaryItem {
  event_type: string;
  count_24h: number;
  count_7d: number;
}

export interface WorkspaceMember {
  userId: string;
  role: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  joinedAt: string;
}

export interface WorkspaceInvitation {
  id: string;
  emailAddress: string;
  role: string;
  createdAt: string;
}

export interface WorkspaceMembersResponse {
  members: WorkspaceMember[];
  invitations: WorkspaceInvitation[];
}
