import readline from "readline";
import { SscClient, writeConfigFile, resolveConfig } from "@ssc/client";

/**
 * Read the API key from the user.
 *
 * TTY mode    — prompt is written to stderr, nothing typed is echoed.
 * Non-TTY mode — read one line from stdin silently (no prompt, no echo).
 *                Useful for `echo ssc_... | ssc login` and test harnesses.
 */
async function readApiKey(): Promise<string> {
  if (process.stdin.isTTY) {
    // Muted TTY read: show prompt on stderr, capture input without echoing.
    process.stderr.write("Paste your SSC API key (ssc_…): ");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    return new Promise<string>((resolve) => {
      let input = "";

      const onData = (char: string) => {
        if (char === "\r" || char === "\n") {
          // Enter — finish
          process.stdin.removeListener("data", onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stderr.write("\n");
          resolve(input.trim());
        } else if (char === "\u0003") {
          // Ctrl-C
          process.stdin.setRawMode(false);
          process.exit(1);
        } else if (char === "\u007f" || char === "\b") {
          // Backspace
          if (input.length > 0) input = input.slice(0, -1);
        } else {
          input += char;
        }
      };

      process.stdin.on("data", onData);
    });
  } else {
    // Non-TTY (pipe / redirect): read one line silently — no prompt, no echo.
    return new Promise<string>((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        terminal: false,
      });
      rl.once("line", (line) => {
        rl.close();
        resolve(line.trim());
      });
    });
  }
}

export async function login(): Promise<void> {
  const apiKey = await readApiKey();

  if (!apiKey.startsWith("ssc_")) {
    console.error("Error: API keys must start with ssc_");
    process.exit(1);
  }

  // Resolve the API URL using the same precedence as all other commands:
  // SSC_API_URL env var > config file api_url > DEFAULT_API_URL.
  // SSC_API_URL is no longer required; the default is used when nothing is set.
  let apiUrl: string;
  try {
    ({ apiUrl } = resolveConfig());
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Validate against the server before saving
  const client = new SscClient({ apiKey, apiUrl });
  let org: string;
  try {
    ({ org } = await client.checkAuth());
  } catch (err) {
    console.error(
      `Error: key validation failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // Persist both key and URL so subsequent commands work without SSC_API_URL set.
  writeConfigFile({ api_key: apiKey, api_url: apiUrl });
  console.log(`Logged in to organization: ${org}`);
}
