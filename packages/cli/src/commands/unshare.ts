import { SscClient } from "@ssc/client";

export async function unshare(appId: string, email: string): Promise<void> {
  const client = new SscClient();
  try {
    await client.unshareApp(appId, email);
    console.log(`Access removed for ${email}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
