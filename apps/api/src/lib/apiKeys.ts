import crypto from "crypto";

export interface GeneratedKey {
  fullKey: string;
  keyPrefix: string;
  keyHash: string;
}

export function generateApiKey(): GeneratedKey {
  const bytes = crypto.randomBytes(32);
  const token = bytes.toString("base64url");
  const fullKey = `ssc_${token}`;
  const keyPrefix = token.slice(0, 8);
  const keyHash = hashApiKey(fullKey);
  return { fullKey, keyPrefix, keyHash };
}

export function hashApiKey(fullKey: string): string {
  return crypto.createHash("sha256").update(fullKey).digest("hex");
}

export function looksLikeApiKey(token: string): boolean {
  return token.startsWith("ssc_") && token.length > 4;
}
