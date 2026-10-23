import readline from "readline";
import { SscClient, writeConfigFile } from "@ssc/client";

export async function login(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // prompts to stderr so stdout stays clean
  });

  const apiKey = await new Promise<string>((resolve) => {
    rl.question("Paste your SSC API key (ssc_…): ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  if (!apiKey.startsWith("ssc_")) {
    console.error("Error: API keys must start with ssc_");
    process.exit(1);
  }

  // Validate against the server before saving
  const client = new SscClient({ apiKey });
  let org: string;
  try {
    ({ org } = await client.checkAuth());
  } catch (err) {
    console.error(
      `Error: key validation failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  writeConfigFile({ api_key: apiKey });
  console.log(`Logged in to organization: ${org}`);
}
