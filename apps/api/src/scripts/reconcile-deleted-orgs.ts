#!/usr/bin/env ts-node
/**
 * reconcile-deleted-orgs
 *
 * Finds Clerk orgs that no longer exist in Clerk (404 + resource_not_found)
 * but still have deleted_at IS NULL in our database, then optionally cleans them.
 *
 * Usage:
 *   npx ts-node --project tsconfig.json src/scripts/reconcile-deleted-orgs.ts
 *   npx ts-node --project tsconfig.json src/scripts/reconcile-deleted-orgs.ts --apply
 *   npx ts-node --project tsconfig.json src/scripts/reconcile-deleted-orgs.ts --apply --max 10
 *   npx ts-node --project tsconfig.json src/scripts/reconcile-deleted-orgs.ts --apply --only <uuid> --only <uuid2>
 *   npx ts-node --project tsconfig.json src/scripts/reconcile-deleted-orgs.ts --apply --yes
 *
 * Default: dry run — prints what would be deleted, makes no changes.
 *
 * --apply            Run deleteWorkspaceData for each orphaned org.
 * --max N            Allow at most N orgs to be cleaned in one run (default: 3).
 *                    --apply is refused if orphanedCount > N unless --max is given.
 * --only <uuid>      Restrict to this internal org UUID (repeatable).
 * --yes              Skip interactive confirmation prompt.
 *
 * Safety rules:
 *   - Only 404 with Clerk's "resource_not_found" error code → orphaned.
 *   - Any other status (401, 403, 429, 5xx) or network/timeout → skipped.
 *   - --apply refused if more than --max orgs would be cleaned.
 *   - Exits non-zero if any error occurred.
 *
 * NEVER point DATABASE_URL at the Railway production database without
 * explicit review — this script writes to the database when --apply is used.
 */

import "dotenv/config";
import * as readline from "readline";
import { pool } from "../db";
import { runReconcile, ReconcileOrgResult } from "../lib/reconcile";

function parseArgs(): {
  apply: boolean;
  max?: number;
  only: string[];
  yes: boolean;
} {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const yes   = argv.includes("--yes");
  const only: string[] = [];
  let max: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max" && argv[i + 1]) {
      const v = parseInt(argv[i + 1], 10);
      if (!Number.isInteger(v) || v < 0) {
        console.error(`[reconcile-deleted-orgs] --max must be a non-negative integer, got: ${argv[i + 1]}`);
        process.exit(1);
      }
      max = v;
      i++;
    } else if (argv[i] === "--only" && argv[i + 1]) {
      only.push(argv[i + 1]);
      i++;
    }
  }

  return { apply, max, only, yes };
}

function formatOrg(r: ReconcileOrgResult): string {
  const counts = `apps=${r.counts.apps} keys=${r.counts.keys} shares=${r.counts.shares}`;
  if (r.status === "live") {
    return `  LIVE     [${r.httpStatus}]: ${r.name} (${r.orgId}, clerk=${r.clerkOrgId}) | ${counts}`;
  }
  if (r.status === "orphaned") {
    return `  ORPHANED [${r.httpStatus}]: ${r.name} (${r.orgId}, clerk=${r.clerkOrgId}) | ${counts}`;
  }
  return `  ERROR    [${r.httpStatus}]: ${r.name} (${r.orgId}, clerk=${r.clerkOrgId}) | ${r.errorMessage ?? "unknown error"}`;
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

async function main(): Promise<void> {
  const { apply, max, only, yes } = parseArgs();
  const mode = apply ? "APPLY" : "dry-run";
  console.log(`[reconcile-deleted-orgs] mode: ${mode}${max !== undefined ? ` --max ${max}` : ""}${only.length > 0 ? ` --only ${only.join(",")}` : ""}`);

  // Phase 1: dry-run scan (always)
  const dryResult = await runReconcile({ apply: false, max, only: only.length > 0 ? only : undefined });

  // Print per-org status
  for (const r of dryResult.orgs) {
    console.log(formatOrg(r));
  }
  console.log(
    `\n[reconcile-deleted-orgs] scan: orphaned=${dryResult.orphanedCount} errors=${dryResult.errorCount}`,
  );

  if (!apply) {
    await pool.end();
    process.exit(dryResult.errorCount > 0 ? 1 : 0);
  }

  // Phase 2: apply safety checks
  const maxAllowed = max ?? 3;
  if (dryResult.orphanedCount > maxAllowed) {
    console.error(
      `\n[reconcile-deleted-orgs] REFUSED: ${dryResult.orphanedCount} orgs would be cleaned, ` +
      `but --max is ${maxAllowed}. Pass --max ${dryResult.orphanedCount} to override.`,
    );
    await pool.end();
    process.exit(1);
  }

  if (dryResult.orphanedCount === 0) {
    console.log("[reconcile-deleted-orgs] no orphaned orgs to clean.");
    await pool.end();
    process.exit(dryResult.errorCount > 0 ? 1 : 0);
  }

  // Print the exact list and ask for confirmation
  console.log("\nOrgs that will be PERMANENTLY deleted:");
  for (const r of dryResult.orgs) {
    if (r.status === "orphaned") {
      console.log(`  • ${r.name} (${r.orgId}, clerk=${r.clerkOrgId}) | apps=${r.counts.apps} keys=${r.counts.keys} shares=${r.counts.shares}`);
    }
  }

  if (!yes) {
    const confirmed = await confirm(`\nProceed with deleting ${dryResult.orphanedCount} workspace(s)? [y/N] `);
    if (!confirmed) {
      console.log("[reconcile-deleted-orgs] aborted.");
      await pool.end();
      process.exit(0);
    }
  }

  // Phase 3: apply
  const applyResult = await runReconcile({ apply: true, max, only: only.length > 0 ? only : undefined, yes: true });

  for (const r of applyResult.orgs) {
    if (r.status === "orphaned") {
      if (r.cleaned) {
        console.log(`  CLEANED: ${r.name} (${r.orgId})`);
      } else {
        console.error(`  ERROR cleaning ${r.orgId}: ${r.errorMessage ?? "unknown"}`);
      }
    }
  }

  console.log(
    `\n[reconcile-deleted-orgs] done. cleaned=${applyResult.cleanedCount} errors=${applyResult.errorCount}`,
  );

  await pool.end();
  process.exit(applyResult.errorCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[reconcile-deleted-orgs] fatal:", err);
  process.exit(1);
});
