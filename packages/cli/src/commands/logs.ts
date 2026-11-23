import { SscClient } from "@ssc/client";

export async function logs(appId: string): Promise<void> {
  const client = new SscClient();
  try {
    const deployments = await client.listDeployments(appId);
    if (deployments.length === 0) {
      console.error("No deployments found for this app.");
      process.exit(1);
    }

    // Find the latest terminal deployment (success, failed, cancelled)
    const TERMINAL = new Set(["success", "failed", "cancelled"]);
    const latest = deployments.find((d) => TERMINAL.has(d.status));
    if (!latest) {
      console.error("No completed deployment found. Build may still be in progress.");
      process.exit(1);
    }

    const log = await client.getBuildLog(appId, latest.id);
    if (log.truncated) {
      process.stderr.write("[build log was truncated]\n");
    }
    process.stdout.write(log.content);
    if (!log.content.endsWith("\n")) process.stdout.write("\n");
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
