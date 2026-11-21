/**
 * deleteWorkspaceData — single entry point for workspace teardown.
 *
 * ONE transaction:
 *   1. Soft-delete all org apps (deleted_at = now())
 *   2. Revoke all org API keys
 *   3. Delete app_access rows for the org's apps
 *   4. Cancel pending email_outbox rows for the org's apps
 *   5. Soft-delete the org itself (deleted_at = now())
 *   6. Write workspace.deleted activity event
 *
 * Returns the result INCLUDING fly_app_ids to destroy.  Callers MUST call
 * destroyWorkspaceFlyApps(result.fly_app_ids) after the transaction so Fly
 * cleanup uses the same code path as single-app delete.
 *
 * Idempotent: safe to call twice.  The org UPDATE is guarded by
 *   WHERE deleted_at IS NULL.  The activity event uses ON CONFLICT on
 *   request_id so a second call writes no duplicate event.
 */

import { pool } from "../db";
import { destroyFlyApp } from "../services/flyClient";
import { ActivityEventType, recordActivityInTx } from "./activityLog";
import { safeErr } from "./safeErr";

export interface DeleteWorkspaceActorInfo {
  userId?: string | null;
  email?: string | null;
  /** Stable dedup key — if omitted, defaults to "workspace.deleted:<orgId>" */
  requestId?: string | null;
}

export interface DeleteWorkspaceResult {
  apps_deleted: number;
  keys_revoked: number;
  invites_cancelled: number;
  already_deleted: boolean;
  /** Fly app IDs to destroy post-commit — call destroyWorkspaceFlyApps() with these */
  fly_app_ids: string[];
}

export async function deleteWorkspaceData(
  orgId: string,
  actor?: DeleteWorkspaceActorInfo,
): Promise<DeleteWorkspaceResult> {
  const requestId = actor?.requestId ?? `workspace.deleted:${orgId}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Step 1: soft-delete apps, capture fly_app_ids for post-commit Fly cleanup
    const { rows: appRows } = await client.query<{ fly_app_id: string | null }>(
      `UPDATE apps SET deleted_at = now()
       WHERE org_id = $1 AND deleted_at IS NULL
       RETURNING fly_app_id`,
      [orgId],
    );
    const appsDeleted = appRows.length;
    const flyAppIds = appRows
      .map((r) => r.fly_app_id)
      .filter((id): id is string => id !== null);

    // Step 2: revoke all org API keys
    const { rowCount: keysRevokedRaw } = await client.query(
      `UPDATE api_keys
       SET revoked_at = now(), revoked_reason = 'workspace_deleted'
       WHERE org_id = $1 AND revoked_at IS NULL`,
      [orgId],
    );
    const keysRevoked = keysRevokedRaw ?? 0;

    // Step 3: delete app_access rows for org's apps
    await client.query(
      `DELETE FROM app_access
       WHERE app_id IN (SELECT id FROM apps WHERE org_id = $1)`,
      [orgId],
    );

    // Step 4: delete pending email_outbox rows for org's apps
    // (deleted rather than status-updated because the workspace is being destroyed —
    //  the count is recorded in the activity event metadata)
    const { rowCount: invitesCancelledRaw } = await client.query(
      `DELETE FROM email_outbox
       WHERE app_id IN (SELECT id FROM apps WHERE org_id = $1)
         AND status IN ('queued', 'sending')`,
      [orgId],
    );
    const invitesCancelled = invitesCancelledRaw ?? 0;

    // Step 5: soft-delete the org itself — WHERE guard makes the function idempotent
    const { rowCount: orgUpdatedRaw } = await client.query(
      `UPDATE orgs SET deleted_at = now()
       WHERE id = $1 AND deleted_at IS NULL`,
      [orgId],
    );
    const alreadyDeleted = (orgUpdatedRaw ?? 0) === 0;

    // Step 6: workspace.deleted activity event (ON CONFLICT on requestId = no duplicate)
    await recordActivityInTx(client, {
      eventType: ActivityEventType.WORKSPACE_DELETED,
      actorType: actor?.userId ? "user" : "system",
      actorUserId: actor?.userId ?? null,
      actorEmail: actor?.email ?? null,
      orgId,
      requestId,
      metadata: {
        apps_deleted: appsDeleted,
        keys_revoked: keysRevoked,
        invites_cancelled: invitesCancelled,
      },
    });

    await client.query("COMMIT");

    return { apps_deleted: appsDeleted, keys_revoked: keysRevoked, invites_cancelled: invitesCancelled, already_deleted: alreadyDeleted, fly_app_ids: flyAppIds };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Destroy Fly apps post-commit.
 * On failure, inserts into orphaned_fly_apps so the existing reaper retries —
 * same mechanism as the single-app delete path in deployRunner.
 * Never throws: HTTP response is already sent.
 */
export async function destroyWorkspaceFlyApps(flyAppIds: string[], orgId?: string | null): Promise<void> {
  for (const flyAppId of flyAppIds) {
    try {
      await destroyFlyApp(flyAppId);
    } catch (err) {
      console.error(`[workspaceDelete] failed to destroy Fly app ${flyAppId}:`, safeErr(err));
      // Record in orphaned_fly_apps so the reaper retries (same path as deployRunner T2)
      await pool.query(
        `INSERT INTO orphaned_fly_apps (fly_app_name, org_id)
         VALUES ($1, $2)
         ON CONFLICT (fly_app_name) DO NOTHING`,
        [flyAppId, orgId ?? null],
      ).catch(() => {});
    }
  }
}
