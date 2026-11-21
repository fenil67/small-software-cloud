#!/usr/bin/env ts-node
/**
 * reconcile-deleted-orgs
 *
 * Finds Clerk orgs that no longer exist in Clerk (404) but still have
 * deleted_at IS NULL in our database, then optionally cleans them up.
 *
 * Usage:
 *   npx ts-node --project tsconfig.json src/scripts/reconcile-deleted-orgs.ts
 *   npx ts-node --project tsconfig.json src/scripts/reconcile-deleted-orgs.ts --apply
 *
 * Default: dry run — prints what would be deleted, makes no changes.
 * --apply: runs deleteWorkspaceData for each orphaned org.
 *
 * NEVER point DATABASE_URL at the Railway production database without
 * explicit review — this script writes to the database when --apply is used.
 */

import "dotenv/config";
import { pool } from "../db";
import { deleteWorkspaceData, destroyWorkspaceFlyApps } from "../lib/workspaceDelete";
import axios, { AxiosError } from "axios";

function clerkApiBase(): string {
  return "https://api.clerk.com/v1";
}

async function checkOrgExistsInClerk(clerkOrgId: string): Promise<boolean> {
  const clerkKey = process.env.CLERK_SECRET_KEY ?? "";
  try {
    await axios.get(`${clerkApiBase()}/organizations/${clerkOrgId}`, {
      headers: { Authorization: `Bearer ${clerkKey}` },
    });
    return true; // org still exists
  } catch (err) {
    const axErr = err as AxiosError;
    if (axErr.response?.status === 404) return false; // deleted in Clerk
    throw err; // network / auth error — do not assume deleted
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(`[reconcile-deleted-orgs] mode: ${apply ? "APPLY" : "dry-run"}`);

  // Find all orgs that are still alive in our DB
  const { rows: orgs } = await pool.query<{ id: string; clerk_org_id: string; name: string }>(
    "SELECT id, clerk_org_id, name FROM orgs WHERE deleted_at IS NULL ORDER BY created_at",
  );
  console.log(`[reconcile-deleted-orgs] checking ${orgs.length} active org(s) against Clerk...`);

  let orphanedCount = 0;
  let cleanedCount = 0;
  let errorCount = 0;

  for (const org of orgs) {
    let existsInClerk: boolean;
    try {
      existsInClerk = await checkOrgExistsInClerk(org.clerk_org_id);
    } catch (err) {
      console.error(`  ERROR checking ${org.clerk_org_id}: ${String(err)}`);
      errorCount++;
      continue;
    }

    if (existsInClerk) continue; // org still live in Clerk — skip

    orphanedCount++;
    console.log(`  ORPHANED: org ${org.id} (${org.name}, clerk=${org.clerk_org_id})`);

    if (!apply) continue; // dry run — just report

    try {
      const result = await deleteWorkspaceData(org.id, {
        requestId: `reconcile:${org.id}`,
      });
      await destroyWorkspaceFlyApps(result.fly_app_ids, org.id);
      console.log(
        `  CLEANED: apps=${result.apps_deleted} keys=${result.keys_revoked} invites=${result.invites_cancelled} fly_apps=${result.fly_app_ids.length}`,
      );
      cleanedCount++;
    } catch (err) {
      console.error(`  ERROR cleaning ${org.id}: ${String(err)}`);
      errorCount++;
    }
  }

  console.log(
    `\n[reconcile-deleted-orgs] done. orphaned=${orphanedCount} cleaned=${cleanedCount} errors=${errorCount}`,
  );

  await pool.end();
  process.exit(errorCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[reconcile-deleted-orgs] fatal:", err);
  process.exit(1);
});
