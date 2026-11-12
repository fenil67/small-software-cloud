/**
 * Proxy credential helpers.
 *
 * issueProxyToken(appId)   — generates a "sscp_" token, stores its SHA-256
 *                            hash (upsert, sets rotated_at on replace), and
 *                            returns the plaintext once.  Never stored or logged.
 *
 * resolveProxyToken(token) — returns the app_id for a valid token, or null.
 *                            Tokens not starting with "sscp_" are rejected
 *                            without touching the DB.
 */

import crypto from "crypto";
import { pool } from "../db";

const PREFIX = "sscp_";

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function issueProxyToken(appId: string): Promise<string> {
  const raw = crypto.randomBytes(32).toString("base64url");
  const token = PREFIX + raw;
  const hash = hashToken(token);

  await pool.query(
    `INSERT INTO proxy_credentials (app_id, token_hash)
     VALUES ($1, $2)
     ON CONFLICT (app_id) DO UPDATE
       SET token_hash = EXCLUDED.token_hash,
           rotated_at = now()`,
    [appId, hash],
  );

  return token;
}

export async function resolveProxyToken(token: string): Promise<string | null> {
  if (!token.startsWith(PREFIX)) return null;
  const hash = hashToken(token);
  const { rows } = await pool.query<{ app_id: string }>(
    "SELECT app_id FROM proxy_credentials WHERE token_hash = $1",
    [hash],
  );
  return rows[0]?.app_id ?? null;
}
