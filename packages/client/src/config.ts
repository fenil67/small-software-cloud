import fs from "fs";
import os from "os";
import path from "path";

const CONFIG_PATH = path.join(os.homedir(), ".config", "ssc", "config.json");

export const DEFAULT_API_URL = "https://api.utir.dev";

interface ConfigFile {
  api_url?: string;
  api_key?: string;
}

function readConfigFile(): ConfigFile {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw) as ConfigFile;
  } catch {
    return {};
  }
}

export function writeConfigFile(data: ConfigFile): void {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
  // Enforce mode even if the file already existed (writeFileSync mode only
  // applies to newly created files on some platforms).
  fs.chmodSync(CONFIG_PATH, 0o600);
}

export interface SscConfig {
  apiUrl: string;
  apiKey: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validates that a URL is safe to use as the SSC API endpoint.
 *
 * Rules:
 *   - Must be a valid URL with no embedded credentials.
 *   - Must use https, EXCEPT http is allowed for localhost, 127.0.0.1, and [::1].
 *
 * Throws a descriptive error naming the host. Never includes an API key.
 */
export function validateApiUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid API URL: "${url}" is not a valid URL.`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(
      `Invalid API URL: credentials must not be embedded in the URL (host: ${parsed.hostname}).`,
    );
  }

  if (parsed.protocol === "https:") return;

  if (parsed.protocol === "http:") {
    if (LOCAL_HOSTS.has(parsed.hostname)) return;
    throw new Error(
      `Invalid API URL: http is only allowed for local development ` +
        `(localhost, 127.0.0.1, [::1]). Got host: ${parsed.hostname}.`,
    );
  }

  throw new Error(
    `Invalid API URL: protocol must be https (or http for localhost). Got: ${parsed.protocol}`,
  );
}

/**
 * Resolve config with precedence:
 *   env vars > ~/.config/ssc/config.json > DEFAULT_API_URL
 */
export function resolveConfig(): SscConfig {
  const file = readConfigFile();

  const apiUrl = process.env.SSC_API_URL ?? file.api_url ?? DEFAULT_API_URL;
  validateApiUrl(apiUrl);

  const apiKey = process.env.SSC_API_KEY ?? file.api_key ?? "";

  return { apiUrl, apiKey };
}
