/**
 * GET  /v1/admin/activity          — list events (keyset pagination + filters)
 * GET  /v1/admin/activity/summary  — counts by event_type (24h + 7d)
 * GET  /v1/admin/activity/:id      — single event
 * GET  /v1/admin/activity/export   — CSV download
 * POST /v1/admin/activity/erase    — GDPR erasure
 *
 * C7: Returns 404 to non-admins (not 403) so endpoint existence is not revealed.
 * Routes are mounted BEFORE the existing adminRouter (which returns 403).
 */

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { pool } from "../db";
import { asyncHandler } from "../lib/asyncHandler";
import { isAdminId } from "./admin";
import {
  ActivityEventType,
  recordActivity,
  recordActivityInTx,
} from "../lib/activityLog";

export const activityAdminRouter = Router();
activityAdminRouter.use(requireAuth);

// ── 404-for-non-admins (C7) ───────────────────────────────────────────────────

activityAdminRouter.use((req: Request, res: Response, next: () => void): void => {
  const auth = req.sscAuth;
  if (
    !auth ||
    auth.type !== "clerk" ||
    !auth.clerkUserId ||
    !isAdminId(auth.clerkUserId)
  ) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  next();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** CSV formula injection escaping (C7): prefix cells that could be formulas. */
function csvEscapeCell(val: string): string {
  if (/^[=+\-@]/.test(val) || val.includes("\t") || val.includes("\r")) {
    return `'${val}`;
  }
  return val;
}

function csvRow(cells: (string | null | undefined)[]): string {
  return cells
    .map((c) => {
      const s = c ?? "";
      const escaped = csvEscapeCell(s);
      // Wrap in double-quotes if contains comma, newline, or double-quote
      if (escaped.includes(",") || escaped.includes("\n") || escaped.includes('"')) {
        return `"${escaped.replace(/"/g, '""')}"`;
      }
      return escaped;
    })
    .join(",");
}

// ── GET /summary — MUST be registered before /:id ────────────────────────────

activityAdminRouter.get(
  "/summary",
  asyncHandler(async (_req: Request, res: Response) => {
    const { rows } = await pool.query<{
      event_type: string;
      count_24h: string;
      count_7d: string;
    }>(`
      SELECT
        event_type,
        COUNT(*) FILTER (WHERE occurred_at > now() - INTERVAL '24 hours') AS count_24h,
        COUNT(*) FILTER (WHERE occurred_at > now() - INTERVAL '7 days')   AS count_7d
      FROM activity_events
      WHERE occurred_at > now() - INTERVAL '7 days'
      GROUP BY event_type
      ORDER BY event_type
    `);
    res.json(rows.map((r) => ({
      event_type: r.event_type,
      count_24h: parseInt(r.count_24h, 10),
      count_7d: parseInt(r.count_7d, 10),
    })));
  }),
);

// ── GET /export — MUST be registered before /:id ─────────────────────────────

activityAdminRouter.get(
  "/export",
  asyncHandler(async (req: Request, res: Response) => {
    // Build query with same filters as GET /
    const { q, event_type, org_id, app_id, actor_user_id, from, to } = req.query as Record<string, string | undefined>;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let pi = 1;

    if (event_type) {
      conditions.push(`ae.event_type = $${pi++}`);
      params.push(event_type);
    }
    if (org_id && isUuid(org_id)) {
      conditions.push(`ae.org_id = $${pi++}`);
      params.push(org_id);
    }
    if (app_id && isUuid(app_id)) {
      conditions.push(`ae.app_id = $${pi++}`);
      params.push(app_id);
    }
    if (actor_user_id && isUuid(actor_user_id)) {
      conditions.push(`ae.actor_user_id = $${pi++}`);
      params.push(actor_user_id);
    }
    if (from) {
      const d = new Date(from);
      if (!isNaN(d.getTime())) {
        conditions.push(`ae.occurred_at >= $${pi++}`);
        params.push(d);
      }
    }
    if (to) {
      const d = new Date(to);
      if (!isNaN(d.getTime())) {
        conditions.push(`ae.occurred_at <= $${pi++}`);
        params.push(d);
      }
    }
    if (q?.trim()) {
      const qTrim = q.trim();
      const likePattern = `%${escapeLike(qTrim)}%`;
      conditions.push(`(
        ae.event_type    ILIKE $${pi}   ESCAPE '\\'
        OR ae.actor_email ILIKE $${pi}   ESCAPE '\\'
        OR ae.target_id   ILIKE $${pi}   ESCAPE '\\'
        OR ae.metadata::text ILIKE $${pi} ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM apps a2 WHERE a2.id = ae.app_id AND a2.name ILIKE $${pi} ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM orgs o2 WHERE o2.id = ae.org_id AND o2.name ILIKE $${pi} ESCAPE '\\')
      )`);
      params.push(likePattern);
      pi++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await pool.query<{
      id: string;
      occurred_at: Date;
      event_type: string;
      actor_type: string;
      actor_email: string | null;
      target_id: string | null;
      app_id: string | null;
      org_id: string | null;
      metadata: Record<string, unknown>;
    }>(`
      SELECT ae.id, ae.occurred_at, ae.event_type, ae.actor_type,
             ae.actor_email, ae.target_id, ae.app_id, ae.org_id, ae.metadata
      FROM activity_events ae
      ${where}
      ORDER BY ae.occurred_at DESC, ae.id DESC
    `, params);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="activity.csv"');

    // Header row
    res.write("id,occurred_at,event_type,actor_type,actor_email,target_id,app_id,org_id,metadata\n");

    for (const row of rows) {
      res.write(
        csvRow([
          row.id,
          row.occurred_at.toISOString(),
          row.event_type,
          row.actor_type,
          row.actor_email ?? "",
          row.target_id ?? "",
          row.app_id ?? "",
          row.org_id ?? "",
          JSON.stringify(row.metadata),
        ]) + "\n",
      );
    }

    res.end();

    // Best-effort audit log
    recordActivity({
      eventType: ActivityEventType.ADMIN_ACTIVITY_EXPORTED,
      actorType: "user",
      actorUserId: null, // resolved below; we can't await here after res.end()
      metadata: { count: rows.length },
    });
  }),
);

// ── POST /erase — MUST be registered before /:id ─────────────────────────────

activityAdminRouter.post(
  "/erase",
  asyncHandler(async (req: Request, res: Response) => {
    const { email } = req.body as { email?: string };
    if (!email || typeof email !== "string") {
      res.status(400).json({ error: "validation_error", message: "email is required" });
      return;
    }
    const trimmedEmail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail) || trimmedEmail.length > 254) {
      res.status(400).json({ error: "validation_error", message: "Invalid email address." });
      return;
    }

    // Resolve internal user ID for the admin actor
    const clerkUserId = req.sscAuth!.clerkUserId!;
    const { rows: userRows } = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE clerk_user_id = $1",
      [clerkUserId],
    );
    const actorUserId: string | null = userRows[0]?.id ?? null;

    // Rate limit: max 5 admin.person_erased events by this user in the last hour
    if (actorUserId) {
      const { rows: rateRows } = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM activity_events
         WHERE event_type = 'admin.person_erased'
           AND actor_user_id = $1
           AND occurred_at > now() - INTERVAL '1 hour'`,
        [actorUserId],
      );
      const cnt = parseInt(rateRows[0]?.cnt ?? "0", 10);
      if (cnt >= 5) {
        res.status(429).json({ error: "rate_limited", message: "Max 5 erasures per hour." });
        return;
      }
    }

    // C4: Escape LIKE wildcards in email for metadata text search
    const escapedEmailPattern = `%${escapeLike(trimmedEmail)}%`;

    const client = await pool.connect();
    let deletedCount = 0;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ssc.allow_erase = 'on'");

      // C4 UPDATE ORDER: UPDATE before DELETE so nothing is skipped

      // 1. Redact PII columns for matching rows
      await client.query(
        `UPDATE activity_events
         SET ip = NULL, user_agent = NULL
         WHERE lower(actor_email) = lower($1) OR lower(target_id) = lower($1)`,
        [trimmedEmail],
      );

      // 2. Redact email from metadata JSONB
      await client.query(
        `UPDATE activity_events
         SET metadata = redact_email_from_jsonb(metadata, $1)
         WHERE metadata::text ILIKE $2 ESCAPE '\\'`,
        [trimmedEmail, escapedEmailPattern],
      );

      // 3. Redact target_id when it equals the email (C4)
      await client.query(
        `UPDATE activity_events
         SET target_id = '[redacted]'
         WHERE lower(target_id) = lower($1)`,
        [trimmedEmail],
      );

      // 4. Delete rows where actor_email matches
      const { rowCount } = await client.query(
        `DELETE FROM activity_events WHERE lower(actor_email) = lower($1)`,
        [trimmedEmail],
      );
      deletedCount = rowCount ?? 0;

      // 5. Insert the erasure audit event (inside same transaction)
      await recordActivityInTx(client, {
        eventType: ActivityEventType.ADMIN_PERSON_ERASED,
        actorType: "user",
        actorUserId,
        metadata: { email_hash: Buffer.from(trimmedEmail.toLowerCase()).toString("base64").slice(0, 32) },
      });

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    res.json({ erased: deletedCount });
  }),
);

// ── GET / — list events with keyset pagination ────────────────────────────────

activityAdminRouter.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const {
      limit: limitStr,
      cursor: cursorStr,
      q,
      event_type,
      org_id,
      app_id,
      actor_user_id,
      from,
      to,
    } = req.query as Record<string, string | undefined>;

    const limit = Math.min(
      parseInt(limitStr ?? "50", 10) || 50,
      200,
    );

    const conditions: string[] = [];
    const params: unknown[] = [];
    let pi = 1;

    // Cursor-based keyset pagination
    if (cursorStr) {
      try {
        const cursor = JSON.parse(
          Buffer.from(cursorStr, "base64").toString("utf8"),
        ) as { occurred_at: string; id: string };
        if (cursor.occurred_at && cursor.id) {
          conditions.push(
            `(ae.occurred_at, ae.id) < ($${pi++}::timestamptz, $${pi++}::uuid)`,
          );
          params.push(cursor.occurred_at, cursor.id);
        }
      } catch {
        // ignore malformed cursor
      }
    }

    if (event_type) {
      conditions.push(`ae.event_type = $${pi++}`);
      params.push(event_type);
    }
    if (org_id && isUuid(org_id)) {
      conditions.push(`ae.org_id = $${pi++}`);
      params.push(org_id);
    }
    if (app_id && isUuid(app_id)) {
      conditions.push(`ae.app_id = $${pi++}`);
      params.push(app_id);
    }
    if (actor_user_id && isUuid(actor_user_id)) {
      conditions.push(`ae.actor_user_id = $${pi++}`);
      params.push(actor_user_id);
    }
    if (from) {
      const d = new Date(from);
      if (!isNaN(d.getTime())) {
        conditions.push(`ae.occurred_at >= $${pi++}`);
        params.push(d);
      }
    }
    if (to) {
      const d = new Date(to);
      if (!isNaN(d.getTime())) {
        conditions.push(`ae.occurred_at <= $${pi++}`);
        params.push(d);
      }
    }
    if (q?.trim()) {
      const qTrim = q.trim();
      const likePattern = `%${escapeLike(qTrim)}%`;
      conditions.push(`(
        ae.event_type    ILIKE $${pi}   ESCAPE '\\'
        OR ae.actor_email ILIKE $${pi}   ESCAPE '\\'
        OR ae.target_id   ILIKE $${pi}   ESCAPE '\\'
        OR ae.metadata::text ILIKE $${pi} ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM apps a2 WHERE a2.id = ae.app_id AND a2.name ILIKE $${pi} ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM orgs o2 WHERE o2.id = ae.org_id AND o2.name ILIKE $${pi} ESCAPE '\\')
      )`);
      params.push(likePattern);
      pi++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Fetch limit+1 to detect if there's a next page
    params.push(limit + 1);
    const { rows } = await pool.query(
      `SELECT ae.*
       FROM activity_events ae
       ${where}
       ORDER BY ae.occurred_at DESC, ae.id DESC
       LIMIT $${pi}`,
      params,
    );

    const hasMore = rows.length > limit;
    const events = hasMore ? rows.slice(0, limit) : rows;

    let next_cursor: string | null = null;
    if (hasMore) {
      const last = events[events.length - 1] as { occurred_at: Date; id: string };
      next_cursor = Buffer.from(
        JSON.stringify({ occurred_at: last.occurred_at, id: last.id }),
      ).toString("base64");
    }

    // Best-effort audit of search
    recordActivity({
      eventType: ActivityEventType.ADMIN_ACTIVITY_SEARCHED,
      actorType: "user",
      actorUserId: null,
      metadata: {
        q: (q ?? "").slice(0, 100),
        event_type: event_type ?? "",
        limit,
        has_cursor: cursorStr ? true : false,
      },
    });

    res.json({ events, next_cursor });
  }),
);

// ── GET /:id — single event ───────────────────────────────────────────────────

activityAdminRouter.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!isUuid(id)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { rows } = await pool.query(
      "SELECT * FROM activity_events WHERE id = $1",
      [id],
    );
    if (!rows[0]) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(rows[0]);
  }),
);
