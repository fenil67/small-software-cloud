/**
 * Minimal, secrets-free environments for child processes.
 *
 * Instead of spreading process.env (which leaks every secret to every
 * subprocess), each helper copies only an explicit allow-list of variables.
 * Any key not in the list is silently excluded.
 */

const COMMON_VARS = ["PATH", "HOME", "LANG", "TMPDIR"] as const;

/**
 * Env for git subprocesses — no secrets, prompt disabled, global config ignored.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of COMMON_VARS) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

/**
 * Env for flyctl subprocesses — only FLY_API_TOKEN + CI=true, no DB/Clerk secrets.
 */
export function flyctlEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of COMMON_VARS) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  if (process.env.FLY_API_TOKEN !== undefined) env.FLY_API_TOKEN = process.env.FLY_API_TOKEN;
  env.CI = "true";
  return env;
}
