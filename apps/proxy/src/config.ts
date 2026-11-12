export interface Config {
  APP_ID: string;
  API_URL: string;
  PROXY_TOKEN: string;
  LOGIN_URL: string;
  LISTEN_PORT: number;
  APP_PORT: number;
  SESSION_TTL_SECONDS: number;
  ACCESS_CACHE_SECONDS: number;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`[proxy] FATAL: ${name} is required but not set`);
    process.exit(1);
  }
  return val;
}

function requireUuid(name: string): string {
  const val = requireEnv(name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)) {
    console.error(`[proxy] FATAL: ${name} must be a UUID, got: ${val}`);
    process.exit(1);
  }
  return val;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function validateUrl(name: string, val: string): void {
  let parsed: URL;
  try {
    parsed = new URL(val);
  } catch {
    console.error(`[proxy] FATAL: ${name} is not a valid URL: ${val}`);
    process.exit(1);
    return;
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname)) return;
  console.error(
    `[proxy] FATAL: ${name} must use https (http allowed only for localhost/127.0.0.1). Got: ${val}`,
  );
  process.exit(1);
}

function requireUrl(name: string): string {
  const val = requireEnv(name);
  validateUrl(name, val);
  return val;
}

function optionalInt(name: string, defaultVal: number): number {
  const val = process.env[name];
  if (val === undefined || val === '') return defaultVal;
  const n = parseInt(val, 10);
  if (Number.isNaN(n) || n <= 0) {
    console.error(`[proxy] FATAL: ${name} must be a positive integer, got: ${val}`);
    process.exit(1);
  }
  return n;
}

export function loadConfig(): Config {
  return {
    APP_ID: requireUuid('SSC_APP_ID'),
    API_URL: requireUrl('SSC_API_URL'),
    PROXY_TOKEN: requireEnv('SSC_PROXY_TOKEN'),
    LOGIN_URL: requireUrl('SSC_LOGIN_URL'),
    LISTEN_PORT: optionalInt('LISTEN_PORT', 8787),
    APP_PORT: optionalInt('APP_PORT', 8080),
    SESSION_TTL_SECONDS: optionalInt('SESSION_TTL_SECONDS', 3600),
    ACCESS_CACHE_SECONDS: optionalInt('ACCESS_CACHE_SECONDS', 60),
  };
}
