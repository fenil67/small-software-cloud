import { SscClient } from "@ssc/client";

export async function share(appId: string, email: string): Promise<void> {
  const client = new SscClient();
  try {
    await client.shareApp(appId, email);
    console.log(`Access granted to ${email}. They get in the next time they sign in with this email.`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
