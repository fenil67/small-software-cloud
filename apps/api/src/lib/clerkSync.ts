import axios from "axios";
import { pool } from "../db";

/**
 * Returns the Clerk API base URL.
 * Production always uses https://api.clerk.com/v1.
 * When SSC_TEST=1 and SSC_TEST_CLERK_API_BASE is set, that value is used instead,
 * allowing tests to point at a fake Clerk endpoint on the test server.
 */
function clerkApiBase(): string {
  if (process.env.SSC_TEST === "1" && process.env.SSC_TEST_CLERK_API_BASE) {
    return process.env.SSC_TEST_CLERK_API_BASE;
  }
  return "https://api.clerk.com/v1";
}

export async function ensureUser(clerkUserId: string): Promise<string> {
  const clerkKey = process.env.CLERK_SECRET_KEY ?? "";

  const { data } = await axios.get(`${clerkApiBase()}/users/${clerkUserId}`, {
    headers: { Authorization: `Bearer ${clerkKey}` },
  });

  // Use only the primary email address, and only when its verification status
  // is "verified".  Never fall back to email_addresses[0] or any non-primary.
  const primaryId: string | undefined = data.primary_email_address_id;
  const emailAddrs: Array<{ id: string; email_address: string; verification: { status: string } | null }> =
    data.email_addresses ?? [];
  const primaryAddr = primaryId ? emailAddrs.find((a) => a.id === primaryId) : undefined;
  const email =
    primaryAddr?.verification?.status === "verified"
      ? (primaryAddr.email_address ?? "")
      : "";
  const name = `${data.first_name ?? ""} ${data.last_name ?? ""}`.trim();

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (clerk_user_id, email, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (clerk_user_id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name
     RETURNING id`,
    [clerkUserId, email, name],
  );
  return rows[0].id;
}

export async function ensureOrg(clerkOrgId: string): Promise<string> {
  const clerkKey = process.env.CLERK_SECRET_KEY ?? "";

  const { data } = await axios.get(`${clerkApiBase()}/organizations/${clerkOrgId}`, {
    headers: { Authorization: `Bearer ${clerkKey}` },
  });

  const name = data.name ?? clerkOrgId;
  const slug = data.slug ?? clerkOrgId;

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO orgs (clerk_org_id, name, slug)
     VALUES ($1, $2, $3)
     ON CONFLICT (clerk_org_id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug
     RETURNING id`,
    [clerkOrgId, name, slug],
  );
  return rows[0].id;
}
