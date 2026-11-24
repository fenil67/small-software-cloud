import { createInterface } from "readline";
import { SscClient } from "@ssc/client";

/** ssc env list <app-id> */
export async function envList(appId: string): Promise<void> {
  const client = new SscClient();
  try {
    const vars = await client.listEnv(appId);
    if (vars.length === 0) {
      console.log("No environment variables set.");
      return;
    }
    for (const v of vars) {
      const by   = v.updated_by_email ? ` (${v.updated_by_email})` : "";
      const when = new Date(v.updated_at).toLocaleString();
      console.log(`  ${v.name.padEnd(32)} ${when}${by}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/** ssc env set <app-id> <name> — reads value from stdin (never from CLI arg) */
export async function envSet(appId: string, name: string): Promise<void> {
  // Reject "NAME=value" syntax — the value must come from stdin, not a CLI arg.
  if (name.includes("=")) {
    console.error(
      `Error: use 'ssc env set ${appId} ${name.split("=")[0]}' and enter the value at the prompt. ` +
      "Passing the value as an argument is not supported (it would appear in shell history).",
    );
    process.exit(1);
  }

  const client = new SscClient();

  // Read value from hidden stdin prompt (never from a CLI argument so the value
  // is never visible in shell history or process listings).
  let value: string;
  if (process.stdin.isTTY) {
    value = await promptSecret(`Value for ${name}: `);
  } else {
    // piped stdin: read the whole input as the value
    value = await readStdin();
  }

  if (!value) {
    console.error("Value cannot be empty.");
    process.exit(1);
  }

  try {
    await client.setEnv(appId, name, value);
    console.log(`Set ${name}. Changes take effect on next deploy or after 'ssc env apply'.`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/** ssc env unset <app-id> <name> */
export async function envUnset(appId: string, name: string): Promise<void> {
  const client = new SscClient();
  try {
    await client.unsetEnv(appId, name);
    console.log(`Removed ${name}.`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/** ssc env apply <app-id> — restart machines so staged changes take effect */
export async function envApply(appId: string): Promise<void> {
  const client = new SscClient();
  try {
    const result = await client.applyEnv(appId);
    if (result.updated === 0) {
      console.log("No running machines to update.");
    } else {
      console.log(`Updated ${result.updated} machine${result.updated === 1 ? "" : "s"}.`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function promptSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    // Hide characters while typing (write prompt manually, suppress echoed input)
    process.stdout.write(prompt);
    // Temporarily suppress stdin echo
    if (process.stdin.isTTY) {
      (process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void }).setRawMode?.(true);
    }
    let value = "";
    process.stdin.on("data", function onData(char: Buffer | string) {
      const s = char.toString();
      if (s === "\r" || s === "\n") {
        process.stdin.removeListener("data", onData);
        if (process.stdin.isTTY) {
          (process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void }).setRawMode?.(false);
        }
        process.stdout.write("\n");
        rl.close();
        resolve(value);
      } else if (s === "\x03") {
        // Ctrl-C
        process.stdout.write("\n");
        process.exit(0);
      } else if (s === "\x7f" || s === "\x08") {
        // Backspace
        value = value.slice(0, -1);
      } else {
        value += s;
      }
    });
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk: Buffer | string) => { data += chunk.toString(); });
    process.stdin.on("end", () => resolve(data.trimEnd()));
  });
}
