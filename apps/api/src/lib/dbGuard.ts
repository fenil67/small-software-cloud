/**
 * assertSafeDatabaseUrl — prevents accidental connections to remote databases
 * outside of a Railway deployment.
 *
 * Rules (checked in order):
 *   1. If RAILWAY_ENVIRONMENT is set → we are on Railway → allow any host.
 *   2. If SSC_ALLOW_REMOTE_DB=1    → explicit override    → allow any host.
 *   3. Otherwise:
 *      a. The ?hostaddr query parameter (if present) must be a local address.
 *      b. The ?host query parameter (if present, checked case-insensitively)
 *         must be a local address or a Unix socket path (starts with "/").
 *      c. The URL's hostname must be a local address, OR the hostname is empty
 *         and ?host is a Unix socket path (Unix socket connection).
 *
 * "Local address" means: localhost, 127.0.0.1, ::1, or [::1].
 * Note: new URL(...).hostname returns "[::1]" with brackets for IPv6 literals,
 * so both "::1" and "[::1]" are accepted.
 *
 * The error message names the offending host value but never the password or
 * the full URL, so it is safe to surface in logs and test output.
 */

const SAFE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLocalHost(h: string): boolean {
  return SAFE_HOSTS.has(h);
}

function isUnixSocket(h: string): boolean {
  return h.startsWith("/");
}

/** Case-insensitive lookup in URLSearchParams. */
function getQueryParamCI(params: URLSearchParams, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [key, value] of params.entries()) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

export function assertSafeDatabaseUrl(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  // Railway deploy — remote DB is expected and correct.
  if (env.RAILWAY_ENVIRONMENT) return;

  // Explicit developer override (e.g. integration tests against a staging DB).
  if (env.SSC_ALLOW_REMOTE_DB === "1") return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "DATABASE_URL is not a valid URL. Cannot verify it points to a safe host.",
    );
  }

  // ── 1. ?hostaddr query parameter ─────────────────────────────────────────
  // libpq uses hostaddr to bypass DNS and connect directly to an IP address.
  // Unix sockets are not applicable for hostaddr, so only local IPs are safe.
  const queryHostaddr = getQueryParamCI(parsed.searchParams, "hostaddr");
  if (queryHostaddr !== null && !isLocalHost(queryHostaddr)) {
    throw new Error(
      `DATABASE_URL contains a ?hostaddr query parameter pointing to a remote host (${queryHostaddr}). ` +
        "Only localhost / 127.0.0.1 / ::1 are allowed unless " +
        "RAILWAY_ENVIRONMENT is set (Railway deploy) or SSC_ALLOW_REMOTE_DB=1 (explicit override).",
    );
  }

  // ── 2. ?host query parameter ──────────────────────────────────────────────
  // libpq treats ?host as the connection target, overriding the URL hostname.
  // A Unix socket path (starts with "/") is a local connection and is safe.
  const queryHost = getQueryParamCI(parsed.searchParams, "host");
  if (queryHost !== null && !isLocalHost(queryHost) && !isUnixSocket(queryHost)) {
    throw new Error(
      `DATABASE_URL contains a ?host query parameter pointing to a remote host (${queryHost}). ` +
        "Only localhost / 127.0.0.1 / ::1 or a Unix socket path are allowed unless " +
        "RAILWAY_ENVIRONMENT is set (Railway deploy) or SSC_ALLOW_REMOTE_DB=1 (explicit override).",
    );
  }

  // ── 3. URL hostname ───────────────────────────────────────────────────────
  const hostname = parsed.hostname;

  if (hostname === "") {
    // An empty hostname is accepted only for Unix socket connections expressed
    // via ?host=/<socket-path>.  Any other empty-hostname URL is ambiguous.
    if (queryHost === null || !isUnixSocket(queryHost)) {
      throw new Error(
        "DATABASE_URL has an empty hostname. " +
          "Only localhost / 127.0.0.1 / ::1 are allowed unless " +
          "RAILWAY_ENVIRONMENT is set (Railway deploy) or SSC_ALLOW_REMOTE_DB=1 (explicit override).",
      );
    }
    // else: Unix socket via ?host — connection stays local, OK.
  } else if (!isLocalHost(hostname)) {
    throw new Error(
      `DATABASE_URL points to a remote host (${hostname}). ` +
        "Only localhost / 127.0.0.1 / ::1 are allowed unless " +
        "RAILWAY_ENVIRONMENT is set (Railway deploy) or " +
        "SSC_ALLOW_REMOTE_DB=1 (explicit override).",
    );
  }
}
