import { SscClient } from "@ssc/client";

export async function listAppAccess(appId: string): Promise<void> {
  const client = new SscClient();
  try {
    const { users, pending } = await client.listAccess(appId);

    if (users.length === 0 && pending.length === 0) {
      console.log("No one has access yet.");
      return;
    }

    for (const u of users) {
      const date = new Date(u.granted_at).toLocaleDateString();
      console.log(`${u.email}  granted ${date}`);
    }
    for (const p of pending) {
      const date = new Date(p.granted_at).toLocaleDateString();
      console.log(`${p.email}  pending ${date}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
