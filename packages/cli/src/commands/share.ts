import { SscClient } from "@ssc/client";

export async function share(appId: string, email: string): Promise<void> {
  const client = new SscClient();
  try {
    const { status } = await client.shareApp(appId, email);
    if (status === "granted") {
      console.log(`Access granted to ${email}`);
    } else {
      console.log(
        `Invitation pending for ${email} (they get access after signing up with this email)`,
      );
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
