import fs from "fs";
import os from "os";
import path from "path";

const CONFIG_PATH = path.join(os.homedir(), ".config", "ssc", "config.json");

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

/**
 * Resolve config with precedence:
 *   env vars > ~/.config/ssc/config.json > error
 */
export function resolveConfig(): SscConfig {
  const file = readConfigFile();

  const apiUrl = process.env.SSC_API_URL ?? file.api_url;
  if (!apiUrl) {
    throw new Error(
      "SSC_API_URL is not configured. Set it via the SSC_API_URL env var, " +
        "or run 'ssc login' (which saves both the key and the URL to ~/.config/ssc/config.json).",
    );
  }

  const apiKey = process.env.SSC_API_KEY ?? file.api_key ?? "";

  return { apiUrl, apiKey };
}
