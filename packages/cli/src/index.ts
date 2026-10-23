#!/usr/bin/env node
import { Command } from "commander";
import { login } from "./commands/login";
import { deploy } from "./commands/deploy";
import { status } from "./commands/status";

const program = new Command();

program
  .name("ssc")
  .description("Small Software Cloud CLI")
  .version("0.1.0");

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

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
