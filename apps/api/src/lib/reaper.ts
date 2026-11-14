/**
 * Deployment reaper.
 *
 * reapStalledDeployments — marks deployments stuck in an in-progress status
 *   for > 15 minutes as failed.
 *
 * reapOrphanedFlyApps — retries destroying Fly apps that deployRunner could
 *   not destroy after all its inline retries.  A 404 from Fly counts as
 *   success (app already gone) and removes the row.
 *
 * Both functions run on API boot and every 5 minutes thereafter.
 */
import { pool } from "../db";
import { safeErr } from "./safeErr";
import { destroyFlyApp } from "../services/flyClient";
import { runProbeRound, runMetricsRound } from "./watchdog";
import { checkOrgMembership } from "./clerkSync";

const TIMEOUT_MINUTES = 15;
const INTERVAL_MS = 5 * 60 * 1000;

export async function reapStalledDeployments(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE deployments
     SET status         = 'failed',
         failure_stage  = 'timeout',
         failure_message = 'Deployment was interrupted or timed out',
         finished_at    = now()
     WHERE status IN ('queued', 'building', 'deploying')
       AND started_at < now() - INTERVAL '${TIMEOUT_MINUTES} minutes'`,
  );
  const count = rowCount ?? 0;
  if (count > 0) {
    console.log(`[reaper] marked ${count} stalled deployment(s) as failed`);
  }
  return count;
}

/**
 * Retries destroying every Fly app recorded in orphaned_fly_apps.
 * Successful destroys (including 404-already-gone) remove the row.
 * Failed destroys update last_error for operator visibility.
 * Returns the number of apps successfully destroyed.
 */
export async function reapOrphanedFlyApps(): Promise<number> {
  const { rows } = await pool.query<{ fly_app_name: string }>(
    "SELECT fly_app_name FROM orphaned_fly_apps ORDER BY created_at",
  );
  if (rows.length === 0) return 0;

  let destroyed = 0;
  for (const { fly_app_name } of rows) {
    try {
      // destroyFlyApp already treats 404 as success — no special case needed.
      await destroyFlyApp(fly_app_name);
      await pool.query(
        "DELETE FROM orphaned_fly_apps WHERE fly_app_name = $1",
        [fly_app_name],
      );
      console.log(`[reaper] destroyed orphaned Fly app: ${fly_app_name}`);
      destroyed++;
    } catch (err) {
      console.error(
        `[reaper] failed to destroy orphaned Fly app ${fly_app_name}:`,
        safeErr(err),
      );
      await pool.query(
        "UPDATE orphaned_fly_apps SET last_error = $1 WHERE fly_app_name = $2",
        [String(safeErr(err)), fly_app_name],
      ).catch(() => {});
    }
  }
  return destroyed;
}

/** Delete proxy_codes rows whose expires_at is more than 1 hour in the past. */
export async function reapExpiredProxyCodes(): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM proxy_codes WHERE expires_at < now() - INTERVAL '1 hour'`,
  );
  const count = rowCount ?? 0;
  if (count > 0) {
    console.log(`[reaper] deleted ${count} expired proxy code(s)`);
  }
  return count;
}

/**
 * Checks every active API key that has a creator and revokes those whose
 * creator has left their org or been deleted.
 *
 * Returns the number of keys revoked.
 * Never revokes on API errors (checkOrgMembership returns null).
 */
export async function reapKeysByMembership(): Promise<number> {
  // Fetch all active keys that have a created_by user
  const { rows } = await pool.query<{
    key_id: string;
    clerk_user_id: string;
    clerk_org_id: string;
  }>(
    `SELECT ak.id AS key_id, u.clerk_user_id, o.clerk_org_id
     FROM api_keys ak
     JOIN users u ON u.id = ak.created_by
     JOIN orgs  o ON o.id = ak.org_id
     WHERE ak.revoked_at IS NULL
       AND ak.created_by IS NOT NULL`,
  );

  let revoked = 0;
  for (const { key_id, clerk_user_id, clerk_org_id } of rows) {
    let result: Awaited<ReturnType<typeof checkOrgMembership>>;
    try {
      result = await checkOrgMembership(clerk_user_id, clerk_org_id);
    } catch {
      // Unexpected error from checkOrgMembership itself — skip
      continue;
    }

    if (result === null) {
      // API error — do not revoke
      continue;
    }

    if (!result.member) {
      const reason = result.reason === "deleted" ? "creator_deleted" : "creator_left_org";
      await pool.query(
        `UPDATE api_keys SET revoked_at = now(), revoked_reason = $1
         WHERE id = $2 AND revoked_at IS NULL`,
        [reason, key_id],
      );
      revoked++;
    }
  }

  if (revoked > 0) {
    console.log(`[reaper] revoked ${revoked} key(s) whose creator left or was deleted`);
  }
  return revoked;
}

const PROBE_INTERVAL_MS    = 5  * 60 * 1000; //  5 minutes
const METRICS_INTERVAL_MS  = 15 * 60 * 1000; // 15 minutes
const MEMBERSHIP_REAP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function startReaper(): void {
  reapStalledDeployments().catch((err) =>
    console.error("[reaper] boot run failed:", safeErr(err)),
  );
  reapOrphanedFlyApps().catch((err) =>
    console.error("[reaper] orphan boot run failed:", safeErr(err)),
  );
  reapExpiredProxyCodes().catch((err) =>
    console.error("[reaper] proxy-codes boot run failed:", safeErr(err)),
  );
  setInterval(() => {
    reapStalledDeployments().catch((err) =>
      console.error("[reaper] interval run failed:", safeErr(err)),
    );
    reapOrphanedFlyApps().catch((err) =>
      console.error("[reaper] orphan interval run failed:", safeErr(err)),
    );
    reapExpiredProxyCodes().catch((err) =>
      console.error("[reaper] proxy-codes interval run failed:", safeErr(err)),
    );
  }, INTERVAL_MS);

  // Hourly membership reconciliation (skipped in test mode — tests trigger via /test/run-key-reconciliation)
  if (process.env.SSC_TEST !== "1") {
    setInterval(() => {
      reapKeysByMembership().catch((err) =>
        console.error("[reaper] membership reap interval failed:", safeErr(err)),
      );
    }, MEMBERSHIP_REAP_INTERVAL_MS);
  }

  // ── Watchdog scheduler ─────────────────────────────────────────────────────
  // Skipped when WATCHDOG_ENABLED=false or SSC_TEST=1 (tests trigger rounds
  // explicitly via /test/run-probe-round and /test/run-metrics-round).
  if (process.env.WATCHDOG_ENABLED !== "false" && process.env.SSC_TEST !== "1") {
    // Stagger the boot run by 30 s to let the server finish starting.
    setTimeout(() => {
      runProbeRound().catch((err) =>
        console.error("[watchdog] probe boot run failed:", safeErr(err)),
      );
      runMetricsRound().catch((err) =>
        console.error("[watchdog] metrics boot run failed:", safeErr(err)),
      );
    }, 30_000);

    setInterval(() => {
      runProbeRound().catch((err) =>
        console.error("[watchdog] probe interval failed:", safeErr(err)),
      );
    }, PROBE_INTERVAL_MS);

    setInterval(() => {
      runMetricsRound().catch((err) =>
        console.error("[watchdog] metrics interval failed:", safeErr(err)),
      );
    }, METRICS_INTERVAL_MS);
  }
}
