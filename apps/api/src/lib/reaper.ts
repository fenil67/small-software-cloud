/**
 * Deployment reaper.
 * Marks deployments stuck in an in-progress status for > 15 minutes as failed.
 * Runs on API boot and every 5 minutes thereafter.
 */
import { pool } from "../db";

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

export function startReaper(): void {
  reapStalledDeployments().catch((err) =>
    console.error("[reaper] boot run failed:", err),
  );
  setInterval(() => {
    reapStalledDeployments().catch((err) =>
      console.error("[reaper] interval run failed:", err),
    );
  }, INTERVAL_MS);
}
