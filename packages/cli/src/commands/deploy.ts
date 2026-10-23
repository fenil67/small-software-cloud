import { SscClient } from "@ssc/client";
import type { DeployEvent } from "@ssc/client";

interface DeployFlags {
  github?: string;
  app?: string;
  name?: string;
}

export async function deploy(
  localPath: string | undefined,
  flags: DeployFlags,
): Promise<void> {
  if (!flags.github && !localPath) {
    console.error("Error: provide a local path or --github <url>");
    process.exit(1);
  }
  if (flags.github && localPath) {
    console.error("Error: --github and a local path are mutually exclusive");
    process.exit(1);
  }

  const client = new SscClient();
  const opts = {
    ...(flags.app ? { appId: flags.app } : {}),
    ...(flags.name ? { appName: flags.name } : {}),
  };

  let deploymentId: string;
  let appId: string;

  try {
    if (flags.github) {
      console.error(`Submitting GitHub URL: ${flags.github}`);
      ({ deployment_id: deploymentId, app_id: appId } =
        await client.deployGithub(flags.github, opts));
    } else {
      console.error(`Zipping ${localPath} …`);
      ({ deployment_id: deploymentId, app_id: appId } =
        await client.deployZip(localPath!, opts));
    }
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  console.error(
    `Deployment started  id=${deploymentId}  app=${appId}`,
  );
  console.error("Streaming logs…\n");

  let failed = false;

  try {
    await client.streamDeployment(deploymentId, (event: DeployEvent) => {
      switch (event.type) {
        case "log":
          process.stderr.write(`  ${event.message}\n`);
          break;
        case "status":
          process.stderr.write(`\n[status] ${event.status}\n`);
          break;
        case "url":
          // Print the live URL to stdout so it can be captured/piped
          process.stdout.write(`${event.url}\n`);
          process.stderr.write(`\nApp URL: ${event.url}\n`);
          break;
        case "error":
          process.stderr.write(
            `\n[error] stage=${event.stage}\n  ${event.message}\n`,
          );
          failed = true;
          break;
        case "done":
          process.stderr.write("\nDone.\n");
          break;
      }
    });
  } catch (err) {
    console.error(
      `Stream error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  if (failed) process.exit(1);
}
