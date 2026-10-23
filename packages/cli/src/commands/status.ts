import { SscClient } from "@ssc/client";

export async function status(deploymentId: string): Promise<void> {
  const client = new SscClient();
  try {
    const d = await client.getDeployment(deploymentId);
    console.log(JSON.stringify(d, null, 2));
    if (d.status === "failed") process.exit(1);
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
