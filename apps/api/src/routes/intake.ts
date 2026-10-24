/**
 * POST /v1/deployments/intake/zip
 * POST /v1/deployments/intake/github
 *
 * Accepts a zip upload or GitHub URL, creates an app + deployment record,
 * kicks off the deploy runner in the background, and returns immediately
 * with { deployment_id, app_id, stream_url }.
 */

import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/requireAuth";
import { pool } from "../db";
import { validateZip, ZipValidationError } from "../lib/zipValidate";
import { checkDeployLimits } from "../lib/deployLimits";
import { ensureUser, ensureOrg } from "../lib/clerkSync";
import { runDeploy } from "../services/deployRunner";
import { asyncHandler } from "../lib/asyncHandler";
import { safeErr } from "../lib/safeErr";

export const intakeRouter = Router();
intakeRouter.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB hard cap (enforced before processing)
});

/**
 * Express middleware that runs multer's upload.single("code") and converts
 * a LIMIT_FILE_SIZE MulterError into a 413 response before it reaches the
 * generic error handler.  All other errors are forwarded via next(err).
 */
function limitedUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single("code")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "file_too_large", message: "Upload exceeds the 50 MB limit." });
      return;
    }
    if (err) { next(err as Error); return; }
    next();
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function resolveOrgId(req: Request): Promise<string | null> {
  const sscAuth = req.sscAuth!;
  if (sscAuth.type === "api_key") return sscAuth.internalOrgId!;
  if (!sscAuth.clerkOrgId) return null;
  return ensureOrg(sscAuth.clerkOrgId);
}

async function resolveUserId(req: Request): Promise<string | null> {
  const sscAuth = req.sscAuth!;
  if (sscAuth.type === "api_key") return sscAuth.apiKeyCreatedBy ?? null;
  if (!sscAuth.clerkUserId) return null;
  return ensureUser(sscAuth.clerkUserId);
}

interface CreateDeployResult {
  deploymentId: string;
  appId: string;
}

async function createAppAndDeployment(
  orgId: string,
  userId: string | null,
  appName: string,
  sourceType: "zip" | "github",
  sourceRef: string | null,
  existingAppId?: string,
): Promise<CreateDeployResult> {
  let appId: string;

  if (existingAppId) {
    // Verify the app belongs to this org
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM apps WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL",
      [existingAppId, orgId],
    );
    if (!rows[0]) throw new Error("app_not_found");
    appId = rows[0].id;

    // Update source info
    await pool.query(
      "UPDATE apps SET source_type = $1, source_ref = $2 WHERE id = $3",
      [sourceType, sourceRef, appId],
    );
  } else {
    // Create a new app
    const slug = appName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50);

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO apps (org_id, owner_id, name, slug, source_type, source_ref)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [orgId, userId, appName, slug, sourceType, sourceRef],
    );
    appId = rows[0].id;
  }

  // Get current version
  const { rows: versionRows } = await pool.query<{ max: number | null }>(
    "SELECT MAX(version) AS max FROM deployments WHERE app_id = $1",
    [appId],
  );
  const nextVersion = (versionRows[0].max ?? 0) + 1;

  // Create deployment record
  const { rows: deployRows } = await pool.query<{ id: string }>(
    `INSERT INTO deployments (app_id, triggered_by, version, status)
     VALUES ($1, $2, $3, 'queued') RETURNING id`,
    [appId, userId, nextVersion],
  );
  const deploymentId = deployRows[0].id;

  return { deploymentId, appId };
}

// ─── POST /zip ────────────────────────────────────────────────────────────────

intakeRouter.post(
  "/zip",
  limitedUpload,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "validation_error", message: "Field 'code' (zip file) is required." });
      return;
    }

    const orgId = await resolveOrgId(req);
    if (!orgId) {
      res.status(400).json({ error: "no_active_org" });
      return;
    }

    // Check limits (skip app limit if we're redeploying)
    const existingAppId = (req.body as { app_id?: string }).app_id;
    const violation = await checkDeployLimits(orgId, { skipAppLimit: !!existingAppId });
    if (violation) {
      res.status(429).json({ error: violation.limit, message: violation.message });
      return;
    }

    // Validate the zip
    try {
      await validateZip(req.file.buffer);
    } catch (err) {
      if (err instanceof ZipValidationError) {
        res.status(400).json({ error: "zip_validation_error", message: err.message });
        return;
      }
      throw err;
    }

    const userId = await resolveUserId(req);
    const appName = ((req.body as { app_name?: string }).app_name ?? "").trim() || "my-app";

    let deploymentId: string;
    let appId: string;

    try {
      ({ deploymentId, appId } = await createAppAndDeployment(
        orgId, userId, appName, "zip", null, existingAppId,
      ));
    } catch (err) {
      if (err instanceof Error && err.message === "app_not_found") {
        res.status(404).json({ error: "app_not_found" });
        return;
      }
      throw err;
    }

    // Kick off deploy in background
    const zipBuffer = req.file.buffer;
    setImmediate(() => {
      runDeploy({ deploymentId, appId, zipBuffer }).catch((e) =>
        console.error("[intake] runDeploy error:", safeErr(e)),
      );
    });

    res.status(202).json({
      deployment_id: deploymentId,
      app_id: appId,
      stream_url: `/v1/deployments/${deploymentId}/stream`,
    });
  }),
);

// ─── POST /github ─────────────────────────────────────────────────────────────

intakeRouter.post("/github", asyncHandler(async (req: Request, res: Response) => {
  const { github_url, app_id: existingAppId, app_name } = req.body as {
    github_url?: string;
    app_id?: string;
    app_name?: string;
  };

  if (!github_url?.trim()) {
    res.status(400).json({ error: "validation_error", message: "Field 'github_url' is required." });
    return;
  }

  // Basic URL validation
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(github_url);
  } catch {
    res.status(400).json({ error: "validation_error", message: "Invalid GitHub URL." });
    return;
  }
  if (parsedUrl.hostname !== "github.com") {
    res.status(400).json({ error: "validation_error", message: "Only github.com URLs are supported." });
    return;
  }

  const orgId = await resolveOrgId(req);
  if (!orgId) {
    res.status(400).json({ error: "no_active_org" });
    return;
  }

  // Check limits
  const violation = await checkDeployLimits(orgId, { skipAppLimit: !!existingAppId });
  if (violation) {
    res.status(429).json({ error: violation.limit, message: violation.message });
    return;
  }

  const userId = await resolveUserId(req);
  const appName = (app_name ?? "").trim() || parsedUrl.pathname.split("/").filter(Boolean)[1] || "my-app";

  let deploymentId: string;
  let appId: string;

  try {
    ({ deploymentId, appId } = await createAppAndDeployment(
      orgId, userId, appName, "github", github_url, existingAppId,
    ));
  } catch (err) {
    if (err instanceof Error && err.message === "app_not_found") {
      res.status(404).json({ error: "app_not_found" });
      return;
    }
    throw err;
  }

  // Kick off deploy in background
  setImmediate(() => {
    runDeploy({ deploymentId, appId, githubUrl: github_url }).catch((e) =>
      console.error("[intake] runDeploy error:", safeErr(e)),
    );
  });

  res.status(202).json({
    deployment_id: deploymentId,
    app_id: appId,
    stream_url: `/v1/deployments/${deploymentId}/stream`,
  });
}));
