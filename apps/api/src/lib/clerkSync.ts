import axios from "axios";
import { pool } from "../db";

export async function ensureUser(clerkUserId: string): Promise<string> {
  const clerkApiBase = "https://api.clerk.com/v1";
  const clerkKey = process.env.CLERK_SECRET_KEY ?? "";

  const { data } = await axios.get(`${clerkApiBase}/users/${clerkUserId}`, {
    headers: { Authorization: `Bearer ${clerkKey}` },
  });

  const email = data.email_addresses?.[0]?.email_address ?? "";
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
  const clerkApiBase = "https://api.clerk.com/v1";
  const clerkKey = process.env.CLERK_SECRET_KEY ?? "";

  const { data } = await axios.get(`${clerkApiBase}/organizations/${clerkOrgId}`, {
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
