import axios from "axios";

/**
 * Thrown by every flyClient function on any HTTP error.
 * Carries only the HTTP status and a safe message — no request config,
 * no headers, no Authorization values.
 */
export class FlyApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "FlyApiError";
  }
}

const FLY_API_DEFAULT = "https://api.machines.dev/v1";

/**
 * Returns the Authorization header value for a Fly API token.
 * Tokens that start with "FlyV1 " are sent as-is (org tokens issued by Fly).
 * All other tokens are prefixed with "Bearer ".
 */
export function flyAuthHeader(token: string): string {
  return token.startsWith("FlyV1 ") ? token : `Bearer ${token}`;
}

/**
 * Resolves the base URL for Fly API calls.
 *
 * FLY_API_BASE is only honoured when the parsed hostname is exactly
 * localhost, 127.0.0.1, or ::1.  Any other value is dropped and the
 * production URL is used — in every environment — so a misconfigured or
 * injected env var cannot redirect FLY_API_TOKEN to an arbitrary host.
 *
 * Exported so tests can assert on the resolution logic without making real
 * network calls.
 */
export function resolveBaseUrl(): string {
  const override = process.env.FLY_API_BASE;
  if (!override) return FLY_API_DEFAULT;

  let hostname: string;
  try {
    hostname = new URL(override).hostname;
  } catch {
    console.error("[fly] ignoring FLY_API_BASE override");
    return FLY_API_DEFAULT;
  }

  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return override;
  }

  console.error("[fly] ignoring FLY_API_BASE override");
  return FLY_API_DEFAULT;
}

function makeClient() {
  const client = axios.create({
    baseURL: resolveBaseUrl(),
    headers: { Authorization: flyAuthHeader(process.env.FLY_API_TOKEN ?? "") },
    timeout: 30_000,
  });

  // ── Response interceptor: strip credentials before errors propagate ──────────
  // Without this, a logged Axios error contains the full request config including
  // "Authorization: Bearer <FLY_API_TOKEN>", which would appear in Railway logs,
  // Sentry, etc.  The interceptor replaces every Axios error with a FlyApiError
  // that carries only status + response body message.
  client.interceptors.response.use(
    (resp) => resp,
    (err: unknown) => {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status ?? 0;
        const data = err.response?.data as Record<string, unknown> | undefined;
        const msg =
          typeof data?.error === "string" ? data.error :
          typeof data?.message === "string" ? data.message :
          `Fly API error (HTTP ${status})`;
        return Promise.reject(new FlyApiError(status, msg));
      }
      return Promise.reject(err);
    },
  );

  return client;
}

export async function createFlyApp(appName: string, orgSlug: string, network: string): Promise<void> {
  const client = makeClient();
  await client.post("/apps", { app_name: appName, org_slug: orgSlug, network });
}

export async function destroyFlyApp(appName: string): Promise<void> {
  const client = makeClient();
  try {
    await client.delete(`/apps/${appName}`);
  } catch (err: unknown) {
    // After the interceptor, errors are FlyApiError instances.
    // A 404 means the app was already deleted — treat as success.
    if (err instanceof FlyApiError && err.status === 404) return;
    throw err;
  }
}

export async function allocateFlyIp(appName: string): Promise<string> {
  const client = makeClient();
  const { data } = await client.post(`/apps/${appName}/allocate-shared-ipv4`);
  return data.address as string;
}

/**
 * Returns true if the named Fly app exists, false on 404.
 * Used by deployRunner to detect apps that were destroyed externally so it can
 * recreate them rather than failing with an unhelpful "app not found" error.
 */
export async function checkFlyAppExists(appName: string): Promise<boolean> {
  const client = makeClient();
  try {
    await client.get(`/apps/${appName}`);
    return true;
  } catch (err) {
    if (err instanceof FlyApiError && err.status === 404) return false;
    throw err;
  }
}

/**
 * Creates an egress network policy for a Fly app that allows DNS and HTTP/S
 * traffic while blocking everything else by default.
 */
export const EGRESS_POLICY_BODY = {
  name: "ssc-default-egress",
  selector: { all: true },
  rules: [
    {
      action: "allow",
      direction: "egress",
      ports: [
        { protocol: "udp", port: 53 },
        { protocol: "tcp", port: 53 },
        { protocol: "tcp", port: 80 },
        { protocol: "tcp", port: 443 },
      ],
    },
  ],
} as const;

export async function createEgressPolicy(appName: string): Promise<void> {
  const client = makeClient();
  await client.post(`/apps/${appName}/network_policies`, EGRESS_POLICY_BODY);
}

export interface FlyMachine {
  id: string;
  state?: string;
}

/** Returns the list of machines for a Fly app. */
export async function listMachines(appName: string): Promise<FlyMachine[]> {
  const client = makeClient();
  const { data } = await client.get<FlyMachine[]>(`/apps/${appName}/machines`);
  return Array.isArray(data) ? data : [];
}

/** Force-destroys a specific machine so auto_start_machines cannot restart it. */
export async function destroyMachine(appName: string, machineId: string): Promise<void> {
  const client = makeClient();
  await client.delete(`/apps/${appName}/machines/${machineId}?force=true`);
}

/**
 * Stages a Fly secret (no machine restart).
 * POST /v1/apps/{app_name}/secrets body: {"values": {"NAME": "value"}}
 * Returns {version: N, secrets: [{name, digest}]}.
 */
export async function setFlySecret(appName: string, name: string, value: string): Promise<void> {
  const client = makeClient();
  await client.post(`/apps/${appName}/secrets`, { values: { [name]: value } });
}

/**
 * Removes a Fly secret by name.
 * DELETE /v1/apps/{app_name}/secrets/{secret_name}
 */
export async function unsetFlySecret(appName: string, name: string): Promise<void> {
  const client = makeClient();
  try {
    await client.delete(`/apps/${appName}/secrets/${encodeURIComponent(name)}`);
  } catch (err) {
    // 404 means secret never existed — treat as success
    if (err instanceof FlyApiError && err.status === 404) return;
    throw err;
  }
}

/**
 * Fetches the full config for a single Fly machine.
 * GET /v1/apps/{app}/machines/{id}
 */
export async function getMachine(appName: string, machineId: string): Promise<unknown> {
  const client = makeClient();
  const { data } = await client.get(`/apps/${appName}/machines/${machineId}`);
  return data;
}

/**
 * Updates a Fly machine with its existing config, triggering a container
 * recreation so staged secrets (set via POST /apps/{app}/secrets) are injected.
 * PUT /v1/apps/{app}/machines/{id}
 *
 * POST .../restart only restarts the process inside the existing container and
 * does NOT pick up secrets staged after the container was created.  A machine
 * UPDATE causes Fly to create a new container from the latest config, which
 * reads the current secret values at startup.  This is what `flyctl secrets
 * deploy` does internally (lm.Update → PUT with MinSecretsVersion).
 */
export async function updateFlyMachine(appName: string, machineId: string, config: unknown): Promise<void> {
  const client = makeClient();
  await client.put(`/apps/${appName}/machines/${machineId}`, config);
}

/**
 * Applies staged secrets to all running machines by fetching each machine's
 * current config and issuing a PUT (machine UPDATE), which recreates the
 * container so the new secrets are injected at startup.
 * Returns the number of machines updated.
 */
export async function updateFlyMachines(appName: string): Promise<{ updated: number }> {
  const machines = await listMachines(appName);
  if (machines.length === 0) return { updated: 0 };
  await Promise.all(
    machines.map(async (m) => {
      const config = await getMachine(appName, m.id);
      await updateFlyMachine(appName, m.id, config);
    }),
  );
  return { updated: machines.length };
}
