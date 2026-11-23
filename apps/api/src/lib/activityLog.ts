/**
 * Activity event log — central write path.
 *
 * recordActivity(input)      — fire-and-forget, never throws
 * recordActivityInTx(client) — transactional, throws on failure
 * shouldThrottleKeyAuthFailed(ip)                        — C2 flood throttle
 * shouldThrottleAccessRefused(appId, userId, reason)     — C2 flood throttle
 */

import { pool } from "../db";
import { safeErr } from "./safeErr";
import type { PoolClient } from "pg";

// ── Event type registry ───────────────────────────────────────────────────────

export const ActivityEventType = {
  KEY_CREATED:              "key.created",
  KEY_REVOKED:              "key.revoked",
  KEY_AUTH_FAILED:          "key.auth_failed",

  ACCESS_GRANTED:           "access.granted",
  ACCESS_REVOKED:           "access.revoked",
  ACCESS_PENDING_CLAIMED:   "access.pending_claimed",
  ACCESS_REFUSED:           "access.refused",

  APP_CREATED:              "app.created",
  APP_DELETED:              "app.deleted",
  APP_SUSPENDED:            "app.suspended",
  APP_UNSUSPENDED:          "app.unsuspended",
  APP_VISIT:                "app.visit",

  DEPLOY_STARTED:           "deploy.started",
  DEPLOY_SUCCEEDED:         "deploy.succeeded",
  DEPLOY_FAILED:            "deploy.failed",

  ADMIN_ACTIVITY_SEARCHED:  "admin.activity_searched",
  ADMIN_ACTIVITY_EXPORTED:  "admin.activity_exported",
  ADMIN_PERSON_ERASED:      "admin.person_erased",

  WATCHDOG_ALERT:           "watchdog.alert",

  USER_SIGNED_IN:           "user.signed_in",

  CLERK_USER_CREATED:       "clerk.user_created",
  CLERK_USER_UPDATED:       "clerk.user_updated",
  CLERK_USER_DELETED:       "clerk.user_deleted",
  CLERK_ORG_CREATED:        "clerk.org_created",
  CLERK_ORG_UPDATED:        "clerk.org_updated",
  CLERK_ORG_DELETED:        "clerk.org_deleted",
  CLERK_MEMBERSHIP_CREATED: "clerk.membership_created",
  CLERK_MEMBERSHIP_UPDATED: "clerk.membership_updated",
  CLERK_MEMBERSHIP_DELETED: "clerk.membership_deleted",

  EMAIL_INVITE_QUEUED:      "email.invite_queued",
  EMAIL_INVITE_SENT:        "email.invite_sent",
  EMAIL_INVITE_FAILED:      "email.invite_failed",

  WORKSPACE_DELETED:        "workspace.deleted",

  USER_ACCOUNT_DELETED:     "user.account_deleted",

  MEMBER_INVITED:           "member.invited",
  MEMBER_INVITATION_REVOKED: "member.invitation_revoked",
  MEMBER_ROLE_CHANGED:      "member.role_changed",
  MEMBER_REMOVED:           "member.removed",
  MEMBER_LEFT:              "member.left",
} as const;

export type ActivityEventTypeValue = (typeof ActivityEventType)[keyof typeof ActivityEventType];

// ── Input interface ───────────────────────────────────────────────────────────

export interface ActivityEventInput {
  eventType: ActivityEventTypeValue;
  actorType: "user" | "api_key" | "system" | "clerk";
  actorUserId?: string | null;
  actorKeyId?: string | null;
  actorEmail?: string | null;
  orgId?: string | null;
  appId?: string | null;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata: Record<string, string | number | boolean | null>;
  requestId?: string | null;
}

// ── C2: In-memory flood throttle maps ────────────────────────────────────────
// key.auth_failed: max 1 DB write per IP per minute
// access.refused:  max 1 DB write per (appId+userId+reason) per 10 minutes

interface ThrottleEntry {
  count: number;
  firstSeen: number;
}

const keyAuthFailedMap = new Map<string, ThrottleEntry>();
const accessRefusedMap = new Map<string, ThrottleEntry>();

const KEY_AUTH_FAILED_WINDOW_MS = 60_000;      // 1 minute
const ACCESS_REFUSED_WINDOW_MS = 10 * 60_000;  // 10 minutes

/**
 * Returns true if the event should be throttled (suppressed from DB).
 * Increments counter; only returns false (allow) for the first hit in the window.
 */
const activitySearchedMap = new Map<string, ThrottleEntry>();
const ACTIVITY_SEARCHED_WINDOW_MS = 10 * 60_000;

export function shouldThrottleActivitySearched(adminId: string, filterKey: string): boolean {
  const key = `${adminId}:${filterKey}`;
  const now = Date.now();
  const entry = activitySearchedMap.get(key);
  if (!entry || now - entry.firstSeen > ACTIVITY_SEARCHED_WINDOW_MS) {
    activitySearchedMap.set(key, { count: 1, firstSeen: now });
    return false;
  }
  entry.count++;
  return true;
}

export function _resetActivitySearchedThrottleForTest(): void {
  activitySearchedMap.clear();
}

/** Test-only: clears both in-memory throttle maps. Never call in production code. */
export function _resetThrottleMapsForTest(): void {
  keyAuthFailedMap.clear();
  accessRefusedMap.clear();
  activitySearchedMap.clear();
}

/** Test-only: causes the next recordActivityInTx call to throw. Never call in production code. */
let _insertFailureArmed = false;
export function _armInsertFailureForTest(): void { _insertFailureArmed = true; }

export function shouldThrottleKeyAuthFailed(ip: string): boolean {
  const now = Date.now();
  const entry = keyAuthFailedMap.get(ip);
  if (!entry || now - entry.firstSeen > KEY_AUTH_FAILED_WINDOW_MS) {
    // New window — allow this write, start counter
    keyAuthFailedMap.set(ip, { count: 1, firstSeen: now });
    return false; // do NOT throttle
  }
  entry.count++;
  return true; // throttle: already wrote one this window
}

export function shouldThrottleAccessRefused(
  appId: string,
  userId: string,
  reason: string,
): boolean {
  const key = `${appId}:${userId}:${reason}`;
  const now = Date.now();
  const entry = accessRefusedMap.get(key);
  if (!entry || now - entry.firstSeen > ACCESS_REFUSED_WINDOW_MS) {
    accessRefusedMap.set(key, { count: 1, firstSeen: now });
    return false;
  }
  entry.count++;
  return true;
}

// ── SQL helpers ───────────────────────────────────────────────────────────────

function buildInsertQuery(input: ActivityEventInput): {
  text: string;
  values: unknown[];
} {
  const text = `
    INSERT INTO activity_events
      (event_type, actor_type, actor_user_id, actor_key_id, actor_email,
       org_id, app_id, target_id, ip, user_agent, metadata, request_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::inet,$10,$11,$12)
    ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING
  `;
  const values: unknown[] = [
    input.eventType,
    input.actorType,
    input.actorUserId ?? null,
    input.actorKeyId ?? null,
    input.actorEmail ?? null,
    input.orgId ?? null,
    input.appId ?? null,
    input.targetId ?? null,
    input.ip ?? null,
    input.userAgent ?? null,
    input.metadata,
    input.requestId ?? null,
  ];
  return { text, values };
}

// ── Public write functions ────────────────────────────────────────────────────

/**
 * Fire-and-forget activity write. Never throws. Best-effort.
 */
export function recordActivity(input: ActivityEventInput): void {
  const { text, values } = buildInsertQuery(input);
  pool.query(text, values).catch((err) => {
    console.error("[activityLog] recordActivity failed:", safeErr(err));
  });
}

/**
 * Transactional activity write (uses caller's pg PoolClient).
 * Throws on DB error — caller must handle.
 */
export async function recordActivityInTx(
  client: PoolClient,
  input: ActivityEventInput,
): Promise<void> {
  if (_insertFailureArmed) {
    _insertFailureArmed = false;
    throw new Error("[test] forced activity insert failure");
  }
  const { text, values } = buildInsertQuery(input);
  await client.query(text, values);
}
