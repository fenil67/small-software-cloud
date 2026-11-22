/**
 * deleteUserData — single entry point for user account teardown.
 *
 * ONE transaction:
 *   1. Revoke all API keys created by this user (across all orgs)
 *   2. NULL out nullable FKs pointing to this user so the users row can be deleted
 *   3. Delete app_access rows for this user
 *   4. Delete the users row (org_members cascade-deletes via FK ON DELETE CASCADE)
 *   5. Write user.account_deleted activity event
 *
 * Precondition: sole-member workspaces must already be cleaned via deleteWorkspaceData
 * before calling this function.  Any remaining org memberships represent multi-member
 * orgs; those will be cleaned up here (membership rows) while the orgs themselves survive.
 *
 * Returns:
 *   keys_revoked  — count of API keys just revoked
 */

import { pool } from "../db";
import { ActivityEventType, recordActivityInTx } from "./activityLog";
import { safeErr } from "./safeErr";

export interface DeleteUserActorInfo {
  clerkUserId?: string | null;
  email?: string | null;
  requestId?: string | null;
}

export interface DeleteUserResult {
  keys_revoked: number;
}

export async function deleteUserData(
  internalUserId: string,
  actor?: DeleteUserActorInfo,
): Promise<DeleteUserResult> {
  const requestId = actor?.requestId ?? `user.account_deleted:${internalUserId}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Step 1: Revoke all un-revoked API keys created by this user
    const { rowCount: keysRevokedRaw } = await client.query(
      `UPDATE api_keys
       SET revoked_at = now(), revoked_reason = 'user_deleted'
       WHERE created_by = $1 AND revoked_at IS NULL`,
      [internalUserId],
    );
    const keysRevoked = keysRevokedRaw ?? 0;

    // Step 2: NULL out all nullable FK columns referencing this user so the
    //         DELETE FROM users below can succeed without FK violations.
    await client.query(
      "UPDATE api_keys SET created_by = NULL WHERE created_by = $1",
      [internalUserId],
    );
    await client.query(
      "UPDATE org_members SET invited_by = NULL WHERE invited_by = $1",
      [internalUserId],
    );
    // apps.owner_id became nullable in migration 016_nullable_app_owner
    await client.query(
      "UPDATE apps SET owner_id = NULL WHERE owner_id = $1",
      [internalUserId],
    );
    await client.query(
      "UPDATE deployments SET triggered_by = NULL WHERE triggered_by = $1",
      [internalUserId],
    );
    // permissions table: granted_by is a nullable FK
    await client.query(
      "UPDATE permissions SET granted_by = NULL WHERE granted_by = $1",
      [internalUserId],
    ).catch((e) => {
      // permissions table may not exist in all environments; ignore FK errors
      console.error("[userDelete] permissions FK cleanup:", safeErr(e));
    });
    // email_outbox: actor_user_id is a nullable FK
    await client.query(
      "UPDATE email_outbox SET actor_user_id = NULL WHERE actor_user_id = $1",
      [internalUserId],
    ).catch(() => {});
    // admin_audit: actor_user_id is a nullable FK
    await client.query(
      "UPDATE admin_audit SET actor_user_id = NULL WHERE actor_user_id = $1",
      [internalUserId],
    ).catch(() => {});

    // Step 3: Remove direct app_access grants for this user
    await client.query(
      "DELETE FROM app_access WHERE user_id = $1",
      [internalUserId],
    );

    // Step 4: Delete the user record.
    // org_members rows with user_id = $1 are cascade-deleted by the FK constraint
    // (ON DELETE CASCADE defined in migration 001).
    await client.query(
      "DELETE FROM users WHERE id = $1",
      [internalUserId],
    );

    // Step 5: Write activity event
    await recordActivityInTx(client, {
      eventType: ActivityEventType.USER_ACCOUNT_DELETED,
      actorType: "user",
      actorUserId: internalUserId,
      actorEmail: actor?.email ?? null,
      requestId,
      metadata: { keys_revoked: keysRevoked },
    });

    await client.query("COMMIT");

    return { keys_revoked: keysRevoked };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
