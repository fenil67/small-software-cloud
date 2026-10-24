/**
 * safeErr(err) — returns a short, secrets-free string describing an error.
 *
 * Safe to write to any log sink (Railway logs, stdout, Sentry, etc.).
 * Never includes:
 *   - Axios request config or headers (which carry Authorization: Bearer <token>)
 *   - Credentials-bearing URLs
 *   - The literal values of known env secrets
 *
 * Always includes:
 *   - Error name
 *   - HTTP status (for Axios/HTTP errors)
 *   - Response error message from the API body (if present)
 *   - Truncated error message (max 200 chars)
 */

const MAX_MSG = 200;

/**
 * Strips known secret patterns from a string.
 * Always the last step in safeErr so no code path can bypass it.
 *
 * Exported for unit testing.
 */
export function scrubSecrets(s: string): string {
  let out = s;

  // "Bearer <token>" — covers Authorization headers, query params, etc.
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");

  // "Authorization: <value>" or "Authorization=<value>"
  out = out.replace(/(Authorization\s*[:=]\s*)([^\s,}"'\]]+)/gi, "$1[REDACTED]");

  // Literal values of known env secrets (only values > 4 chars to avoid trivial matches)
  const candidates: string[] = [
    process.env.FLY_API_TOKEN,
    process.env.CLERK_SECRET_KEY,
  ].filter((v): v is string => typeof v === "string" && v.length > 4);

  // Extract DATABASE_URL password component only (not the whole URL, which is useful for context)
  try {
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      const parsed = new URL(dbUrl);
      if (parsed.password && parsed.password.length > 4) candidates.push(parsed.password);
    }
  } catch { /* ignore malformed DATABASE_URL */ }

  for (const secret of candidates) {
    // split+join avoids regex special-character escaping issues
    out = out.split(secret).join("[REDACTED]");
  }

  return out;
}

/**
 * Returns a short safe string describing `err`.
 *
 * Format:
 *   Axios error  → "<name> HTTP <status> response="<body.error>" msg="<message>""
 *   Plain error  → "<name> msg="<message>""
 *   String       → "<truncated string>"
 */
export function safeErr(err: unknown): string {
  if (err === null || err === undefined) {
    return "(null/undefined error)";
  }

  let name = "Error";
  let message = "(no message)";
  let httpStatus: number | undefined;
  let responseMsg: string | undefined;

  if (typeof err === "string") {
    return scrubSecrets(err.slice(0, MAX_MSG));
  }

  if (err instanceof Error) {
    name = err.name || "Error";
    message = err.message.slice(0, MAX_MSG);
  } else {
    message = String(err).slice(0, MAX_MSG);
  }

  // Duck-type check for Axios errors — avoids importing axios into this utility.
  // The flyClient response interceptor should already have replaced Axios errors
  // with FlyApiError before this runs; safeErr handles the raw shape as defence-in-depth.
  const a = err as Record<string, unknown>;
  if (a.isAxiosError === true) {
    const resp = a.response as Record<string, unknown> | undefined;
    httpStatus = typeof resp?.status === "number" ? resp.status : undefined;

    const data = resp?.data;
    if (data !== null && data !== undefined) {
      if (typeof data === "object") {
        const d = data as Record<string, unknown>;
        responseMsg =
          typeof d.error === "string" ? d.error.slice(0, MAX_MSG) :
          typeof d.message === "string" ? d.message.slice(0, MAX_MSG) :
          undefined;
      } else if (typeof data === "string") {
        responseMsg = data.slice(0, MAX_MSG);
      }
    }

    // Axios embeds the full request URL in the message; strip it.
    message = message.replace(/https?:\/\/\S+/g, "[URL]");
  }

  const parts: string[] = [name];
  if (httpStatus !== undefined) parts.push(`HTTP ${httpStatus}`);
  if (responseMsg) parts.push(`response="${responseMsg}"`);
  parts.push(`msg="${message}"`);

  return scrubSecrets(parts.join(" "));
}
