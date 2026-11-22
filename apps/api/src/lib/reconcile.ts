/**
 * reconcile — core logic for reconcile-deleted-orgs.
 *
 * Separated from the CLI script so it can be called from tests via
 * /test/run-reconcile without spawning a child process.
 *
 * Safety rules (enforced inside runReconcile):
 *   - 404 without Clerk's "resource_not_found" error code → error, not orphaned.
 *   - Any non-404 HTTP status (401, 403, 429, 5xx) → error, skip the org.
 *   - Network error / timeout (httpStatus 0) → error, skip.
 *   - --apply with orphanedCount > max (default 3) → refused, nothing cleaned.
 */

import axios, { AxiosError } from "axios";
import { pool } from "../db";
import { deleteWorkspaceData, destroyWorkspaceFlyApps } from "./workspaceDelete";

function reconcileClerkApiBase(): string {
  if (process.env.SSC_TEST === "1" && process.env.SSC_TEST_CLERK_API_BASE) {
    return process.env.SSC_TEST_CLERK_API_BASE;
  }
  return "https://api.clerk.com/v1";
}

// ── Discriminated union for a single org check ────────────────────────────────

export type ClerkOrgCheck =
  | { found: true; httpStatus: 200 }
  | { found: false; httpStatus: 404 }   // 404 + resource_not_found in body
  | { error: true; httpStatus: number; message: string }; // anything else

/**
 * Checks whether an org exists in Clerk.
 *
 * Returns:
 *   { found: true }                        — 200 OK
 *   { found: false }                       — 404 with resource_not_found code
 *   { error: true, httpStatus, message }   — any other result (401/403/429/5xx/timeout/network)
 *
 * Any result other than 404+resource_not_found is treated as an error — the org
 * is NOT considered orphaned and is NOT cleaned.
 */
export async function defaultClerkOrgCheck(clerkOrgId: string): Promise<ClerkOrgCheck> {
  const clerkKey = process.env.CLERK_SECRET_KEY ?? "";
  try {
    await axios.get(`${reconcileClerkApiBase()}/organizations/${clerkOrgId}`, {
      headers: { Authorization: `Bearer ${clerkKey}` },
      timeout: 10_000,
    });
    return { found: true, httpStatus: 200 };
  } catch (err) {
    const axErr = err as AxiosError;
    const status = axErr.response?.status ?? 0;
    if (status === 404) {
      // Only treat as not_found when Clerk returns its specific resource_not_found code.
      // A 404 without this code (e.g., wrong Clerk instance, auth mismatch) is an error.
      const body = axErr.response?.data as { errors?: Array<{ code?: string }> } | undefined;
      const code = body?.errors?.[0]?.code;
      if (code === "resource_not_found") {
        return { found: false, httpStatus: 404 };
      }
      return {
        error: true,
        httpStatus: 404,
        message: `404 without resource_not_found (code=${code ?? "none"}) — possible instance mismatch`,
      };
    }
    const message =
      axErr.code === "ECONNABORTED" || axErr.code === "ETIMEDOUT"
        ? `timeout (${axErr.code})`
        : (axErr.message || "network error");
    return { error: true, httpStatus: status, message };
  }
}

// ── Per-org counts for dry-run output ─────────────────────────────────────────

export interface OrgCounts {
  apps: number;
  keys: number;
  shares: number;
}

async function getOrgCounts(orgId: string): Promise<OrgCounts> {
  const { rows } = await pool.query<{ apps: string; keys: string; shares: string }>(
    `SELECT
       (SELECT COUNT(*) FROM apps
        WHERE org_id = $1 AND deleted_at IS NULL)                                     AS apps,
       (SELECT COUNT(*) FROM api_keys
        WHERE org_id = $1 AND revoked_at IS NULL)                                     AS keys,
       (SELECT COUNT(*) FROM app_access
        WHERE app_id IN (SELECT id FROM apps WHERE org_id = $1 AND deleted_at IS NULL)) AS shares`,
    [orgId],
  );
  return {
    apps:   parseInt(rows[0].apps,   10),
    keys:   parseInt(rows[0].keys,   10),
    shares: parseInt(rows[0].shares, 10),
  };
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface ReconcileOrgResult {
  orgId:     string;
  clerkOrgId: string;
  name:      string;
  status:    "live" | "orphaned" | "error";
  httpStatus: number;      // 0 for network/timeout
  counts:    OrgCounts;
  errorMessage?: string;
  cleaned?:  boolean;
}

export interface ReconcileOptions {
  apply: boolean;
  /**
   * Maximum number of orgs that may be cleaned in a single --apply run.
   * Defaults to 3 when not set.  Pass Infinity to disable the guard.
   */
  max?: number;
  /**
   * When set, only these internal org UUIDs are checked/cleaned.
   * All other orgs are skipped.
   */
  only?: string[];
  /** Skip interactive confirmation (used by tests and --yes CLI flag). */
  yes?: boolean;
}

export interface ReconcileResult {
  orgs:         ReconcileOrgResult[];
  orphanedCount: number;
  errorCount:   number;
  cleanedCount: number;
  /** Set to true when --apply was requested but the --max guard blocked it. */
  refused?: boolean;
}

// ── Main function ─────────────────────────────────────────────────────────────

export async function runReconcile(
  opts: ReconcileOptions,
  clerkCheck: (clerkOrgId: string) => Promise<ClerkOrgCheck> = defaultClerkOrgCheck,
): Promise<ReconcileResult> {
  const { apply, only } = opts;
  const maxAllowed = opts.max ?? 3;

  // Fetch candidate orgs (all non-deleted, or restricted by --only)
  let query = `SELECT id, clerk_org_id, name FROM orgs WHERE deleted_at IS NULL`;
  const queryParams: string[] = [];
  if (only && only.length > 0) {
    query += ` AND id = ANY($1::uuid[])`;
    queryParams.push(only as unknown as string); // pg driver accepts string[]
  }
  query += ` ORDER BY created_at`;

  const { rows: orgs } = await pool.query<{ id: string; clerk_org_id: string; name: string }>(
    query,
    only && only.length > 0 ? [only] : [],
  );

  const results: ReconcileOrgResult[] = [];
  let orphanedCount = 0;
  let errorCount = 0;

  for (const org of orgs) {
    const counts = await getOrgCounts(org.id);
    const check = await clerkCheck(org.clerk_org_id);

    if ("error" in check) {
      errorCount++;
      results.push({
        orgId:      org.id,
        clerkOrgId: org.clerk_org_id,
        name:       org.name,
        status:     "error",
        httpStatus: check.httpStatus,
        counts,
        errorMessage: check.message,
      });
      continue;
    }

    if (check.found) {
      results.push({
        orgId:      org.id,
        clerkOrgId: org.clerk_org_id,
        name:       org.name,
        status:     "live",
        httpStatus: 200,
        counts,
      });
      continue;
    }

    // 404 + resource_not_found → orphaned
    orphanedCount++;
    results.push({
      orgId:      org.id,
      clerkOrgId: org.clerk_org_id,
      name:       org.name,
      status:     "orphaned",
      httpStatus: 404,
      counts,
    });
  }

  if (!apply) {
    return { orgs: results, orphanedCount, errorCount, cleanedCount: 0 };
  }

  // ── --apply safety guard ───────────────────────────────────────────────────
  if (orphanedCount > maxAllowed) {
    return { orgs: results, orphanedCount, errorCount, cleanedCount: 0, refused: true };
  }

  // ── Clean each orphaned org ────────────────────────────────────────────────
  let cleanedCount = 0;
  let applyErrorCount = 0;

  for (const r of results) {
    if (r.status !== "orphaned") continue;
    try {
      const result = await deleteWorkspaceData(r.orgId, { requestId: `reconcile:${r.orgId}` });
      await destroyWorkspaceFlyApps(result.fly_app_ids, r.orgId);
      r.cleaned = true;
      cleanedCount++;
    } catch (err) {
      r.errorMessage = String(err);
      applyErrorCount++;
    }
  }

  errorCount += applyErrorCount;
  return { orgs: results, orphanedCount, errorCount, cleanedCount };
}
