import axios, { AxiosError } from "axios";
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

/**
 * Checks whether a Clerk user is still a member of a Clerk org.
 *
 * Returns:
 *   { member: true }                        — user exists and is a member
 *   { member: false, reason: "deleted" }    — user's Clerk account was deleted (404)
 *   { member: false, reason: "left" }       — user exists but is not in the org
 *   null                                    — API error; caller should NOT revoke
 */
export async function checkOrgMembership(
  clerkUserId: string,
  clerkOrgId: string,
): Promise<{ member: boolean; reason?: "left" | "deleted" } | null> {
  const clerkKey = process.env.CLERK_SECRET_KEY ?? "";
  const base = clerkApiBase();

  // Step 1: check the user still exists.
  // Only treat as "deleted" when Clerk returns 404 AND the body contains
  // resource_not_found.  Any other status or a 404 without that code is
  // treated as an API error so the caller does NOT revoke the key.
  try {
    await axios.get(`${base}/users/${clerkUserId}`, {
      headers: { Authorization: `Bearer ${clerkKey}` },
    });
  } catch (err) {
    const axErr = err as AxiosError;
    if (axErr.response?.status === 404) {
      const body = axErr.response.data as { errors?: Array<{ code?: string }> } | undefined;
      const code = body?.errors?.[0]?.code;
      if (code === "resource_not_found") {
        return { member: false, reason: "deleted" };
      }
      // 404 without resource_not_found — treat as API error, do not revoke
      return null;
    }
    // Any other error (5xx, network) → caller must not revoke
    return null;
  }

  // Step 2: check org membership
  try {
    const { data } = await axios.get(
      `${base}/organizations/${clerkOrgId}/memberships`,
      {
        params: { user_id: clerkUserId },
        headers: { Authorization: `Bearer ${clerkKey}` },
      },
    );
    const totalCount: number = (data as { total_count?: number }).total_count ?? 0;
    if (totalCount === 0) {
      return { member: false, reason: "left" };
    }
    return { member: true };
  } catch {
    // API error → do not revoke
    return null;
  }
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

/**
 * Deletes a Clerk organization via the Clerk backend API.
 * Throws on network or API errors — callers should catch and decide whether
 * to surface clerk_deleted: false or surface the error.
 */
export async function deleteClerkOrg(clerkOrgId: string): Promise<void> {
  const clerkKey = process.env.CLERK_SECRET_KEY ?? "";
  await axios.delete(`${clerkApiBase()}/organizations/${clerkOrgId}`, {
    headers: { Authorization: `Bearer ${clerkKey}` },
  });
}

/**
 * Deletes a Clerk user via the Clerk backend API.
 * Throws on network or API errors — callers should catch and decide whether
 * to surface clerk_deleted: false or surface the error.
 */
export async function deleteClerkUser(clerkUserId: string): Promise<void> {
  const clerkKey = process.env.CLERK_SECRET_KEY ?? "";
  await axios.delete(`${clerkApiBase()}/users/${clerkUserId}`, {
    headers: { Authorization: `Bearer ${clerkKey}` },
  });
}

/**
 * Fetches the current display name of a Clerk organization.
 * Returns null on any error (network, 404, etc.) — callers should treat null as a 503.
 */
export async function getClerkOrgDisplayName(clerkOrgId: string): Promise<string | null> {
  const clerkKey = process.env.CLERK_SECRET_KEY ?? "";
  try {
    const { data } = await axios.get(`${clerkApiBase()}/organizations/${clerkOrgId}`, {
      headers: { Authorization: `Bearer ${clerkKey}` },
    });
    return typeof data.name === "string" ? data.name : null;
  } catch {
    return null;
  }
}

// ── getUserOrgIds: paginated fetch with 60-second per-user cache ──────────────

/** Page limit for Clerk org-membership list calls. Lowerable in tests. */
let _orgIdsFetchLimit = 100;
/** Test-only: sets the per-page limit for getUserOrgIds. Never call in production code. */
export function _setOrgIdsFetchLimitForTest(n: number): void { _orgIdsFetchLimit = n; }

interface OrgIdsCacheEntry { value: string[]; expiresAt: number; }
const _orgIdsCache = new Map<string, OrgIdsCacheEntry>();
/** Test-only: clears the getUserOrgIds per-user cache. Never call in production code. */
export function _clearOrgIdsCacheForTest(): void { _orgIdsCache.clear(); }

/**
 * Returns all Clerk org IDs that the given user is currently a member of.
 * Fetches all pages (Clerk paginates at 10 by default; we use limit=100 per page).
 * Caches results per user for 60 seconds.
 * Returns null on any API error — callers should treat null as a 503.
 */
export async function getUserOrgIds(clerkUserId: string): Promise<string[] | null> {
  const cached = _orgIdsCache.get(clerkUserId);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  const clerkKey = process.env.CLERK_SECRET_KEY ?? "";
  const limit = _orgIdsFetchLimit;
  const allMemberships: Array<{ organization: { id: string } }> = [];
  let offset = 0;

  try {
    while (true) {
      const { data } = await axios.get(
        `${clerkApiBase()}/users/${clerkUserId}/organization_memberships`,
        {
          params: { limit, offset },
          headers: { Authorization: `Bearer ${clerkKey}` },
        },
      );
      const page = ((data as { data?: unknown[] }).data ?? []) as Array<{ organization: { id: string } }>;
      allMemberships.push(...page);
      if (page.length < limit) break;
      offset += limit;
    }
    const orgIds = allMemberships.map((m) => m.organization.id);
    _orgIdsCache.set(clerkUserId, { value: orgIds, expiresAt: Date.now() + 60_000 });
    return orgIds;
  } catch {
    return null; // errors are not cached — next call will retry
  }
}

// ── Org membership and invitation helpers ─────────────────────────────────────

export interface ClerkOrgMember {
  userId: string;
  role: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  joinedAt: string;
}

/** Fetches all current members of a Clerk org (paginates until done). */
export async function listOrgMembersAll(clerkOrgId: string): Promise<ClerkOrgMember[]> {
  const clerkKey = process.env.CLERK_SECRET_KEY ?? "";
  const base = clerkApiBase();
  const limit = 100;
  const all: ClerkOrgMember[] = [];
  let offset = 0;
  while (true) {
    const { data } = await axios.get(`${base}/organizations/${clerkOrgId}/memberships`, {
      params: { limit, offset },
      headers: { Authorization: `Bearer ${clerkKey}` },
    });
    const page = ((data as { data?: unknown[] }).data ?? []) as Array<{
      role: string;
      created_at: number;
      public_user_data: {
        user_id: string;
        identifier: string;
        first_name: string | null;
        last_name: string | null;
      };
    }>;
    for (const m of page) {
      all.push({
        userId: m.public_user_data.user_id,
        role: m.role,
        email: m.public_user_data.identifier,
        firstName: m.public_user_data.first_name ?? null,
        lastName: m.public_user_data.last_name ?? null,
        joinedAt: new Date(m.created_at).toISOString(),
      });
    }
    if (page.length < limit) break;
    offset += limit;
  }
  return all;
}

export interface ClerkOrgInvitation {
  id: string;
  emailAddress: string;
  role: string;
  createdAt: string;
}

/** Fetches all pending invitations for a Clerk org (paginates until done). */
export async function listOrgInvitationsAll(clerkOrgId: string): Promise<ClerkOrgInvitation[]> {
  const clerkKey = process.env.CLERK_SECRET_KEY ?? "";
  const base = clerkApiBase();
  const limit = 100;
  const all: ClerkOrgInvitation[] = [];
  let offset = 0;
  while (true) {
    const { data } = await axios.get(`${base}/organizations/${clerkOrgId}/invitations`, {
      params: { status: "pending", limit, offset },
      headers: { Authorization: `Bearer ${clerkKey}` },
    });
    const page = ((data as { data?: unknown[] }).data ?? []) as Array<{
      id: string;
      email_address: string;
      role: string;
      created_at: number;
    }>;
    for (const inv of page) {
      all.push({
        id: inv.id,
        emailAddress: inv.email_address,
        role: inv.role,
        createdAt: new Date(inv.created_at).toISOString(),
      });
    }
    if (page.length < limit) break;
    offset += limit;
  }
  return all;
}

/** Creates a Clerk org invitation. Throws on API error. */
export async function createOrgInvitationClerk(
  clerkOrgId: string,
  email: string,
  role: string,
  redirectUrl: string,
): Promise<{ id: string }> {
  const clerkKey = process.env.CLERK_SECRET_KEY ?? "";
  const { data } = await axios.post(
    `${clerkApiBase()}/organizations/${clerkOrgId}/invitations`,
    { email_address: email, role, redirect_url: redirectUrl },
    { headers: { Authorization: `Bearer ${clerkKey}` } },
  );
  return { id: (data as { id: string }).id };
}

/** Revokes a pending Clerk org invitation. Throws on API error. */
export async function revokeOrgInvitationClerk(
  clerkOrgId: string,
  invitationId: string,
): Promise<void> {
  const clerkKey = process.env.CLERK_SECRET_KEY ?? "";
  await axios.post(
    `${clerkApiBase()}/organizations/${clerkOrgId}/invitations/${invitationId}/revoke`,
    {},
    { headers: { Authorization: `Bearer ${clerkKey}` } },
  );
}

/** Updates a member's role in a Clerk org. Throws on API error. */
export async function updateOrgMemberRoleClerk(
  clerkOrgId: string,
  userId: string,
  role: string,
): Promise<void> {
  const clerkKey = process.env.CLERK_SECRET_KEY ?? "";
  await axios.patch(
    `${clerkApiBase()}/organizations/${clerkOrgId}/memberships/${userId}`,
    { role },
    { headers: { Authorization: `Bearer ${clerkKey}` } },
  );
}

/** Removes a member from a Clerk org. Throws on API error. */
export async function removeOrgMemberClerk(
  clerkOrgId: string,
  userId: string,
): Promise<void> {
  const clerkKey = process.env.CLERK_SECRET_KEY ?? "";
  await axios.delete(
    `${clerkApiBase()}/organizations/${clerkOrgId}/memberships/${userId}`,
    { headers: { Authorization: `Bearer ${clerkKey}` } },
  );
}

/**
 * Returns the count of org:admin members in a Clerk org.
 * Fetches the first page (limit=1) and uses total_count if the API supports
 * role filtering; otherwise falls back to listing all members client-side.
 */
export async function countOrgAdmins(clerkOrgId: string): Promise<number> {
  const members = await listOrgMembersAll(clerkOrgId);
  return members.filter((m) => m.role === "org:admin").length;
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
