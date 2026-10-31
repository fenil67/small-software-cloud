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

export function startReaper(): void {
  reapStalledDeployments().catch((err) =>
    console.error("[reaper] boot run failed:", safeErr(err)),
  );
  reapOrphanedFlyApps().catch((err) =>
    console.error("[reaper] orphan boot run failed:", safeErr(err)),
  );
  setInterval(() => {
    reapStalledDeployments().catch((err) =>
      console.error("[reaper] interval run failed:", safeErr(err)),
    );
    reapOrphanedFlyApps().catch((err) =>
      console.error("[reaper] orphan interval run failed:", safeErr(err)),
    );
  }, INTERVAL_MS);
}
