/**
 * Normalises a value from the API's `subdomain` field into a safe https:// URL.
 *
 * The API stores subdomain as a full URL (e.g. "https://ssc-x.fly.dev").
 * Legacy web code prepended https:// again, producing "https://https://ssc-x.fly.dev".
 * This helper accepts both forms and returns a canonical "https://<host>" string,
 * or null if the value is absent, uses a disallowed scheme, targets a non-.fly.dev
 * host, or contains userinfo / path tricks.
 *
 * Rules:
 *   - null/undefined/empty → null
 *   - Strip any number of leading "https://" prefixes (handles double-scheme)
 *   - After stripping, if any "://" remains → null (unexpected scheme in host position)
 *   - http://, javascript:, data:, ftp:, etc. → null (before stripping)
 *   - Host must end with ".fly.dev" (exact suffix match, e.g. "ssc-x.fly.dev")
 *   - Host must not contain "@", "/", "?", "#", ":" (no userinfo, path, port)
 *   - Host must not start with "."
 */
export function appUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;

  // Reject non-https schemes before stripping
  if (/^(http|javascript|data|ftp|file):/i.test(v)) return null;

  // Strip all "https://" prefixes (handles single and double scheme)
  let host = v;
  while (host.startsWith("https://")) {
    host = host.slice("https://".length);
  }

  // After stripping, any remaining "://" means an unexpected scheme in host position
  if (host.includes("://")) return null;

  // Structural validation of the bare hostname
  if (host.startsWith(".")) return null;
  if (host.includes("@")) return null; // userinfo
  if (host.includes("/")) return null; // path
  if (host.includes("?")) return null; // query string
  if (host.includes("#")) return null; // fragment
  if (host.includes(":")) return null; // port

  // Must end with ".fly.dev"
  if (!host.endsWith(".fly.dev")) return null;

  return `https://${host}`;
}
