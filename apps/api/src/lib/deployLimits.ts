import { pool } from "../db";

export interface LimitViolation {
  limit: string;
  message: string;
  current: number;
  max: number;
}

interface CheckOptions {
  skipAppLimit?: boolean;
}

export async function checkDeployLimits(
  orgId: string,
  opts: CheckOptions = {},
): Promise<LimitViolation | null> {
  // 1. Concurrent deployments
  const { rows: concurrent } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM deployments d
     JOIN apps a ON a.id = d.app_id
     WHERE a.org_id = $1
       AND d.status IN ('queued', 'building', 'deploying')`,
    [orgId],
  );
  const concurrentCount = parseInt(concurrent[0].count);
  if (concurrentCount >= 3) {
    return { limit: "concurrent_deploys", message: "Maximum 3 concurrent deployments allowed.", current: concurrentCount, max: 3 };
  }

  // 2. Hourly deploys
  const { rows: hourly } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM deployments d
     JOIN apps a ON a.id = d.app_id
     WHERE a.org_id = $1
       AND d.started_at > now() - INTERVAL '1 hour'`,
    [orgId],
  );
  const hourlyCount = parseInt(hourly[0].count);
  if (hourlyCount >= 10) {
    return { limit: "hourly_deploys", message: "Maximum 10 deployments per hour allowed.", current: hourlyCount, max: 10 };
  }

  // 3. App count — only active apps (not deleted, not all-failed)
  //    An app counts against the limit only if it has at least one non-failed deployment
  //    OR it was created but has no deployments yet (brand new).
  //    Apps where deleted_at IS NOT NULL are excluded.
  if (!opts.skipAppLimit) {
    const { rows: apps } = await pool.query<{ count: string }>(
      `SELECT COUNT(DISTINCT a.id) AS count
       FROM apps a
       WHERE a.org_id = $1
         AND a.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM deployments d
           WHERE d.app_id = a.id
             AND d.status != 'failed'
         )`,
      [orgId],
    );
    const appCount = parseInt(apps[0].count);
    if (appCount >= 10) {
      return { limit: "app_count", message: "Maximum 10 active apps per organization.", current: appCount, max: 10 };
    }
  }

  return null;
}
