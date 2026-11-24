#!/usr/bin/env node
import { Command } from "commander";
import { login } from "./commands/login";
import { deploy } from "./commands/deploy";
import { status } from "./commands/status";
import { logs } from "./commands/logs";
import { share } from "./commands/share";
import { unshare } from "./commands/unshare";
import { listAppAccess } from "./commands/access";
import { destroy } from "./commands/destroy";
import { envList, envSet, envUnset, envApply } from "./commands/env";

const program = new Command();

program
  .name("ssc")
  .description("Utir CLI")
  .version("0.1.1");

// ─── login ────────────────────────────────────────────────────────────────────
program
  .command("login")
  .description("Save an SSC API key to ~/.config/ssc/config.json")
  .action(async () => {
    await login();
  });

// ─── deploy ───────────────────────────────────────────────────────────────────
program
  .command("deploy [path]")
  .description("Deploy a local directory or GitHub repository")
  .option("--github <url>", "Deploy from a public GitHub URL instead of a local path")
  .option("--app <id>", "Redeploy an existing app (app ID)")
  .option("--name <name>", "Name for a new app")
  .action(async (localPath: string | undefined, flags) => {
    await deploy(localPath, flags as { github?: string; app?: string; name?: string });
  });

// ─── status ───────────────────────────────────────────────────────────────────
program
  .command("status <deployment_id>")
  .description("Print the current status of a deployment (JSON)")
  .action(async (deploymentId: string) => {
    await status(deploymentId);
  });

// ─── logs ─────────────────────────────────────────────────────────────────────
program
  .command("logs <app-id>")
  .description("Print the build log for the latest completed deployment")
  .action(async (appId: string) => {
    await logs(appId);
  });

// ─── share ────────────────────────────────────────────────────────────────────
program
  .command("share <app-id> <email>")
  .description("Grant a user access to an app by email")
  .action(async (appId: string, email: string) => {
    await share(appId, email);
  });

// ─── unshare ──────────────────────────────────────────────────────────────────
program
  .command("unshare <app-id> <email>")
  .description("Revoke a user's access to an app")
  .action(async (appId: string, email: string) => {
    await unshare(appId, email);
  });

// ─── access ───────────────────────────────────────────────────────────────────
program
  .command("access <app-id>")
  .description("List who has access to an app")
  .action(async (appId: string) => {
    await listAppAccess(appId);
  });

// ─── destroy ──────────────────────────────────────────────────────────────────
program
  .command("destroy <app-id>")
  .description("Permanently delete an app (requires name confirmation)")
  .option("--confirm <name>", "App name to confirm deletion (skips interactive prompt)")
  .action(async (appId: string, flags: { confirm?: string }) => {
    await destroy(appId, flags);
  });

// ─── env ──────────────────────────────────────────────────────────────────────
const envCmd = program
  .command("env")
  .description("Manage environment variables for an app");

envCmd
  .command("list <app-id>")
  .description("List environment variable names (never values)")
  .action(async (appId: string) => {
    await envList(appId);
  });

envCmd
  .command("set <app-id> <name>")
  .description("Set or replace an environment variable (value read from prompt or stdin, never from CLI argument)")
  .allowExcessArguments(false)
  .action(async (appId: string, name: string) => {
    await envSet(appId, name);
  });

envCmd
  .command("unset <app-id> <name>")
  .description("Remove an environment variable")
  .action(async (appId: string, name: string) => {
    await envUnset(appId, name);
  });

envCmd
  .command("apply <app-id>")
  .description("Restart app machines so staged env changes take effect")
  .action(async (appId: string) => {
    await envApply(appId);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
