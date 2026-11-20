/**
 * Shared app-URL normalizer.
 *
 * Accepts a raw subdomain value from the apps.subdomain column, which may be:
 *   "ssc-abc12345.fly.dev"               → "https://ssc-abc12345.fly.dev"
 *   "https://ssc-abc12345.fly.dev"        → "https://ssc-abc12345.fly.dev"
 *   "https://https://ssc-abc12345.fly.dev"→ "https://ssc-abc12345.fly.dev"
 *   null / ""                             → null
 *   anything that doesn't end in .fly.dev → null
 *
 * Used by: appAccess route, email outbox sender, /v1/me/shared-apps.
 */
export function normalizeAppUrl(subdomain: string | null | undefined): string | null {
  if (!subdomain) return null;
  let host = subdomain.trim();
  if (!host) return null;

  // Strip any number of "https://" prefixes stored in the field
  while (host.startsWith("https://")) host = host.slice(8);

  // Must end with .fly.dev
  if (!host.endsWith(".fly.dev")) return null;

  // Reject userinfo, paths, ports, queries, fragments, or a leading dot
  if (
    host.includes("@") ||
    host.includes("/") ||
    host.includes(":") ||
    host.includes("?") ||
    host.includes("#") ||
    host.startsWith(".")
  ) {
    return null;
  }

  return `https://${host}`;
}
