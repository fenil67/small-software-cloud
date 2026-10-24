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
    headers: { Authorization: `Bearer ${process.env.FLY_API_TOKEN}` },
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

export async function createFlyApp(appName: string, orgSlug: string): Promise<void> {
  const client = makeClient();
  await client.post("/apps", { app_name: appName, org_slug: orgSlug });
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
