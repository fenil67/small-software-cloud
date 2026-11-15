/**
 * Returns a safe redirect path for use in auth flows.
 *
 * Rules:
 *  - If input is an absolute URL whose origin === currentOrigin (same scheme,
 *    host, and port), no userinfo, path not suspicious → returns pathname+search+hash.
 *  - Otherwise treats as relative: must start with "/", no "//", no backslash,
 *    no control chars, max 2048 chars, decoded safely.
 *  - Any failure → returns "/".
 */
export function safeRedirectPath(
  input: unknown,
  currentOrigin: string,
): string {
  if (typeof input !== "string" || input.length === 0) return "/";
  if (input.length > 2048) return "/";

  // Absolute URL branch
  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      // Must match origin exactly (scheme, host, port all equal)
      if (url.origin !== currentOrigin) return "/";
      // No userinfo
      if (url.username || url.password) return "/";
      return validateRelative(url.pathname + url.search + url.hash);
    } catch {
      return "/";
    }
  }

  return validateRelative(input);
}

function validateRelative(path: string): string {
  if (!path.startsWith("/")) return "/";
  // Reject protocol-relative "//"
  if (path.startsWith("//")) return "/";
  // Reject backslash (open-redirect via backslash)
  if (path.includes("\\")) return "/";
  // Decode percent-encoding safely to look for smuggled sequences
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return "/";
  }
  // Reject control characters (0x00–0x1F, 0x7F)
  if (/[\x00-\x1F\x7F]/.test(decoded)) return "/";
  // Reject backslash in decoded form
  if (decoded.includes("\\")) return "/";
  // Reject protocol-relative in decoded form
  if (decoded.startsWith("//")) return "/";

  return path;
}
