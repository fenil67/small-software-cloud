import readline from "readline";
import { SscClient } from "@ssc/client";

export async function destroy(appId: string, flags: { confirm?: string }): Promise<void> {
  const client = new SscClient();

  let app: Awaited<ReturnType<SscClient["getApp"]>>;
  try {
    app = await client.getApp(appId);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const appUrl = app.subdomain ? `https://${app.subdomain}` : "no URL";
  console.log(
    `About to permanently delete ${app.name} (${appUrl}). This cannot be undone.`,
  );

  // Determine confirmed name
  let confirmedName: string;

  if (flags.confirm !== undefined) {
    // --confirm flag provided
    confirmedName = flags.confirm;
  } else if (process.stdin.isTTY) {
    // Interactive TTY — prompt
    confirmedName = await new Promise<string>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question("Type the app name to confirm: ", (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  } else {
    // Non-TTY and no --confirm
    console.error(
      "Refusing to delete without confirmation. Re-run with --confirm <app name>.",
    );
    process.exit(1);
  }

  if (confirmedName !== app.name) {
    console.error(
      "Confirmation does not match the app name. Nothing was deleted.",
    );
    process.exit(1);
  }

  try {
    await client.deleteApp(appId);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log(`Deleted ${app.name}.`);
}
