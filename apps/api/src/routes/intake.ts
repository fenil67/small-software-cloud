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
import { requireAuth } from "../middleware/requireAuth";
import { pool } from "../db";
import { runDeploy } from "../services/deployRunner";

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

    try {
      const internalUserId = await ensureUser(userId);
      const internalOrgId = await ensureOrg(orgId);

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
      console.error("[intake/zip]", err);
      res.status(500).json({ error: "internal_error" });
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

  try {
    const internalUserId = await ensureUser(userId);
    const internalOrgId = await ensureOrg(orgId);

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
    console.error("[intake/github]", err);
    res.status(500).json({ error: "internal_error" });
  }
});
