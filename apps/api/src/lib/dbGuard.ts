/**
 * assertSafeDatabaseUrl — prevents accidental connections to remote databases
 * outside of a Railway deployment.
 *
 * Rules (checked in order):
 *   1. If RAILWAY_ENVIRONMENT is set → we are on Railway → allow any host.
 *   2. If SSC_ALLOW_REMOTE_DB=1    → explicit override    → allow any host.
 *   3. Otherwise the host must be localhost, 127.0.0.1, or ::1.
 *
 * The error message names the offending host but never the password or the
 * full URL, so it is safe to surface in logs and test output.
 */

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

  const host = parsed.hostname;
  const safeHosts = new Set(["localhost", "127.0.0.1", "::1"]);

  if (!safeHosts.has(host)) {
    throw new Error(
      `DATABASE_URL points to a remote host (${host}). ` +
        "Only localhost / 127.0.0.1 / ::1 are allowed unless " +
        "RAILWAY_ENVIRONMENT is set (Railway deploy) or " +
        "SSC_ALLOW_REMOTE_DB=1 (explicit override).",
    );
  }
}
