/**
 * Deploy intake endpoints.
 *
 * POST /v1/deployments/intake/zip    — multipart, field "code" is the zip file
 * POST /v1/deployments/intake/github — JSON { github_url, app_name? }
 *
 * Both endpoints:
 *   1. Upsert user + org in our DB (from Clerk auth context)
 *   2. Create an app record and a deployment record (status: queued)
 *   3. Fire the deploy job in the background
 *   4. Return immediately with { deployment_id, app_id, stream_url }
 */

import { Router, Request, Response } from "express";
import multer from "multer";
import { getAuth } from "@clerk/express";
import { clerkClient } from "@clerk/express";
import axios from "axios";
import { requireAuth } from "../middleware/requireAuth";
import { pool } from "../db";
import { runDeploy } from "../services/deployRunner";

// ─── Error helpers ────────────────────────────────────────────────────────────

type IntakeErrorCode =
  | "clerk_api_error"
  | "db_error"
  | "fly_api_error"
  | "internal_error";

interface IntakeError {
  code: IntakeErrorCode;
  message: string;
  /** HTTP status code to reply with */
  status: number;
  /** Raw upstream detail for server-side logging only */
  detail?: unknown;
}

/**
 * Classify a thrown value into a structured IntakeError.
 * Covers:
 *   - Clerk SDK errors (wrapped Axios internally)
 *   - Fly Machines API errors (direct Axios calls)
 *   - node-postgres errors (ERR_INVALID_URL, connection refused, constraint violations)
 *   - Generic Error
 */
function classifyError(err: unknown, step: string): IntakeError {
  // Axios error (Fly API or Clerk HTTP layer)
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const body = err.response?.data;
    const bodyMsg =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>).error ??
          (body as Record<string, unknown>).message ??
          JSON.stringify(body)
        : String(body ?? err.message);

    if (step.startsWith("clerk")) {
      return {
        code: "clerk_api_error",
        message: `Clerk API error in ${step}: ${status} ${bodyMsg}`,
        status: 502,
        detail: body,
      };
    }
    return {
      code: "fly_api_error",
      message: `Fly API error in ${step}: ${status} ${bodyMsg}`,
      status: 502,
      detail: body,
    };
  }

  if (err instanceof Error) {
    const msg = err.message;

    // pg / pg-connection-string URL parse failure
    if ((err as NodeJS.ErrnoException).code === "ERR_INVALID_URL") {
      return {
        code: "db_error",
        message: `DATABASE_URL is malformed — check the format (postgres://user:pass@host:port/dbname with no extra colon before the path)`,
        status: 500,
        detail: msg,
      };
    }

    // pg ECONNREFUSED / ENOTFOUND
    if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") || msg.includes("connect ETIMEDOUT")) {
      return {
        code: "db_error",
        message: `Database unreachable in ${step}: ${msg}`,
        status: 500,
        detail: msg,
      };
    }

    // pg constraint violations (23xxx class)
    if ("code" in err && typeof (err as Record<string, unknown>).code === "string") {
      const pgCode = (err as Record<string, unknown>).code as string;
      if (pgCode.startsWith("23")) {
        return {
          code: "db_error",
          message: `Database constraint violation in ${step}: ${msg}`,
          status: 409,
          detail: msg,
        };
      }
    }

    return {
      code: "internal_error",
      message: `Unexpected error in ${step}: ${msg}`,
      status: 500,
      detail: msg,
    };
  }

  return {
    code: "internal_error",
    message: `Unknown error in ${step}`,
    status: 500,
    detail: String(err),
  };
}

export const intakeRouter = Router();
intakeRouter.use(requireAuth);

// 50 MB limit on zip uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Upsert user → returns internal UUID. */
async function ensureUser(clerkUserId: string): Promise<string> {
  const clerkUser = await clerkClient.users.getUser(clerkUserId);
  const email =
    clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)
      ?.emailAddress ?? clerkUser.emailAddresses[0]?.emailAddress ?? "";
  const displayName = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") || null;

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (clerk_user_id, email, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (clerk_user_id)
     DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, updated_at = now()
     RETURNING id`,
    [clerkUserId, email, displayName]
  );
  return rows[0].id;
}

/** Upsert org → returns internal UUID. */
async function ensureOrg(clerkOrgId: string): Promise<string> {
  const org = await clerkClient.organizations.getOrganization({ organizationId: clerkOrgId });
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO orgs (clerk_org_id, name, slug)
     VALUES ($1, $2, $3)
     ON CONFLICT (clerk_org_id)
     DO UPDATE SET name = EXCLUDED.name, updated_at = now()
     RETURNING id`,
    [clerkOrgId, org.name, org.slug ?? clerkOrgId]
  );
  return rows[0].id;
}

/** Generate a slug-safe name: random 8-char hex */
function randomSlug(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Create app + deployment records. Returns their IDs. */
async function createAppAndDeployment(
  orgId: string,
  ownerId: string,
  appName: string,
  sourceType: "zip" | "github",
  sourceRef: string | null
): Promise<{ appId: string; deploymentId: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: appRows } = await client.query<{ id: string }>(
      `INSERT INTO apps (org_id, owner_id, name, slug, source_type, source_ref)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [orgId, ownerId, appName, appName, sourceType, sourceRef]
    );
    const appId = appRows[0].id;

    const { rows: deployRows } = await client.query<{ id: string }>(
      `INSERT INTO deployments (app_id, triggered_by, version, status, started_at)
       VALUES ($1, $2, 1, 'queued', now())
       RETURNING id`,
      [appId, ownerId]
    );
    const deploymentId = deployRows[0].id;

    await client.query("COMMIT");
    return { appId, deploymentId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─── Zip upload ───────────────────────────────────────────────────────────────

intakeRouter.post(
  "/zip",
  upload.single("code"),
  async (req: Request, res: Response) => {
    const { userId, orgId } = getAuth(req);
    if (!userId) { res.status(401).json({ error: "unauthenticated" }); return; }
    if (!orgId) { res.status(400).json({ error: "no_active_org" }); return; }

    if (!req.file) {
      res.status(400).json({ error: "Missing file field 'code'" });
      return;
    }

    let internalUserId: string, internalOrgId: string;
    try {
      internalUserId = await ensureUser(userId);
    } catch (err) {
      const e = classifyError(err, "clerk.getUser");
      console.error("[intake/zip] ensureUser failed:", e.message, e.detail ?? "");
      res.status(e.status).json({ error: e.code, message: e.message });
      return;
    }
    try {
      internalOrgId = await ensureOrg(orgId);
    } catch (err) {
      const e = classifyError(err, "clerk.getOrganization");
      console.error("[intake/zip] ensureOrg failed:", e.message, e.detail ?? "");
      res.status(e.status).json({ error: e.code, message: e.message });
      return;
    }

    try {
      const appName: string = (req.body.app_name as string | undefined) ?? `app-${randomSlug()}`;
      const { appId, deploymentId } = await createAppAndDeployment(
        internalOrgId,
        internalUserId,
        appName,
        "zip",
        null
      );

      // Fire-and-forget — response returns before deploy finishes
      const zipBuffer = req.file.buffer;
      setImmediate(() =>
        runDeploy({ deploymentId, appId, zipBuffer })
      );

      res.status(202).json({
        deployment_id: deploymentId,
        app_id: appId,
        stream_url: `/v1/deployments/${deploymentId}/stream`,
      });
    } catch (err) {
      const e = classifyError(err, "createAppAndDeployment");
      console.error("[intake/zip] DB transaction failed:", e.message, e.detail ?? "");
      res.status(e.status).json({ error: e.code, message: e.message });
    }
  }
);

// ─── GitHub URL ───────────────────────────────────────────────────────────────

intakeRouter.post("/github", async (req: Request, res: Response) => {
  const { userId, orgId } = getAuth(req);
  if (!userId) { res.status(401).json({ error: "unauthenticated" }); return; }
  if (!orgId) { res.status(400).json({ error: "no_active_org" }); return; }

  const { github_url, app_name } = req.body as {
    github_url?: string;
    app_name?: string;
  };

  if (!github_url) {
    res.status(400).json({ error: "Missing field: github_url" });
    return;
  }

  // Basic sanity check — must look like a GitHub HTTPS URL
  if (!github_url.match(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/)) {
    res.status(400).json({
      error: "github_url must be a public GitHub HTTPS URL (https://github.com/owner/repo)",
    });
    return;
  }

  let internalUserId: string, internalOrgId: string;
  try {
    internalUserId = await ensureUser(userId);
  } catch (err) {
    const e = classifyError(err, "clerk.getUser");
    console.error("[intake/github] ensureUser failed:", e.message, e.detail ?? "");
    res.status(e.status).json({ error: e.code, message: e.message });
    return;
  }
  try {
    internalOrgId = await ensureOrg(orgId);
  } catch (err) {
    const e = classifyError(err, "clerk.getOrganization");
    console.error("[intake/github] ensureOrg failed:", e.message, e.detail ?? "");
    res.status(e.status).json({ error: e.code, message: e.message });
    return;
  }

  try {
    const repoName = github_url.split("/").pop()?.replace(/\.git$/, "") ?? "app";
    const finalName = app_name ?? `${repoName}-${randomSlug()}`;

    const { appId, deploymentId } = await createAppAndDeployment(
      internalOrgId,
      internalUserId,
      finalName,
      "github",
      github_url
    );

    setImmediate(() =>
      runDeploy({ deploymentId, appId, githubUrl: github_url })
    );

    res.status(202).json({
      deployment_id: deploymentId,
      app_id: appId,
      stream_url: `/v1/deployments/${deploymentId}/stream`,
    });
  } catch (err) {
    const e = classifyError(err, "createAppAndDeployment");
    console.error("[intake/github] DB transaction failed:", e.message, e.detail ?? "");
    res.status(e.status).json({ error: e.code, message: e.message });
  }
});
