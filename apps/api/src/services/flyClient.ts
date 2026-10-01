/**
 * Thin client for the Fly Machines REST API.
 * Base: https://api.machines.dev/v1
 * Auth: Authorization: Bearer <FLY_API_TOKEN>
 *
 * Only the endpoints needed for Phase 1 are implemented here.
 */

import axios, { AxiosInstance } from "axios";

const MACHINES_API = "https://api.machines.dev/v1";
const LOGS_API = "https://api.fly.io/api/v1";

function makeClient(): AxiosInstance {
  const token = process.env.FLY_API_TOKEN;
  if (!token) throw new Error("FLY_API_TOKEN is not set");

  return axios.create({
    baseURL: MACHINES_API,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30_000,
  });
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FlyMachine {
  id: string;
  name: string;
  state: "created" | "starting" | "started" | "stopping" | "stopped" | "destroying" | "destroyed";
  region: string;
  private_ip: string;
  created_at: string;
  updated_at: string;
  image_ref: { registry: string; repository: string; tag: string; digest: string };
}

export interface FlyLogEntry {
  id: string;
  timestamp: string;
  level: string;
  message: string;
  instance: string;
  region: string;
}

// ─── App operations ──────────────────────────────────────────────────────────

/** Create a Fly app. Throws if the name is already taken. */
export async function createFlyApp(appName: string, orgSlug: string): Promise<void> {
  const client = makeClient();
  await client.post("/apps", { app_name: appName, org_slug: orgSlug });
}

/** Returns true if the app exists. */
export async function flyAppExists(appName: string): Promise<boolean> {
  const client = makeClient();
  try {
    await client.get(`/apps/${appName}`);
    return true;
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return false;
    throw err;
  }
}

// ─── Machine operations ───────────────────────────────────────────────────────

/** List machines for an app. */
export async function listMachines(appName: string): Promise<FlyMachine[]> {
  const client = makeClient();
  const { data } = await client.get<FlyMachine[]>(`/apps/${appName}/machines`);
  return data;
}

/**
 * Wait for a machine to reach the desired state (default: "started").
 * Polls until done or times out.
 */
export async function waitForMachine(
  appName: string,
  machineId: string,
  state: "started" | "stopped" | "destroyed" = "started",
  timeoutSeconds = 120
): Promise<void> {
  const client = makeClient();
  await client.get(
    `/apps/${appName}/machines/${machineId}/wait?state=${state}&timeout=${timeoutSeconds}`
  );
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

/**
 * Cursor-poll logs for an app from the Fly logs API.
 * Returns [entries, nextToken].
 * Pass nextToken from the previous call to get only new entries.
 */
export async function pollLogs(
  appName: string,
  nextToken?: string
): Promise<{ entries: FlyLogEntry[]; nextToken: string | null }> {
  const token = process.env.FLY_API_TOKEN;
  if (!token) throw new Error("FLY_API_TOKEN is not set");

  const logsClient = axios.create({
    baseURL: LOGS_API,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10_000,
  });

  const params: Record<string, string> = {};
  if (nextToken) params.next_token = nextToken;

  const { data } = await logsClient.get<{
    data: Array<{ id: string; attributes: FlyLogEntry }>;
    meta?: { next_token?: string };
  }>(`/apps/${appName}/logs`, { params });

  const entries = (data.data ?? []).map((d) => d.attributes);
  return {
    entries,
    nextToken: data.meta?.next_token ?? null,
  };
}
