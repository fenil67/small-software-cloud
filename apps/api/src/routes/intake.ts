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
import { requireScope } from "../middleware/requireScope";
import { pool } from "../db";
import { validateZip, ZipValidationError } from "../lib/zipValidate";
import { checkDeployLimits } from "../lib/deployLimits";
import { parseGithubUrl, GithubUrlError } from "../lib/githubUrl";
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

// ─── Slug helpers ─────────────────────────────────────────────────────────────

class NameTakenError extends Error {
  constructor(public appName: string) {
    super("name_taken");
  }
}

function isPgUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "app"
  );
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6); // 4 chars, e.g. "k3x9"
}

/**
 * Finds an app eligible for retry: same slug, not deleted/suspended, no Fly app,
 * and EVERY deployment has status='failed' (at least one must exist).
 * This excludes apps still in progress (queued/building/deploying).
 */
async function findReuseableApp(orgId: string, slug: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM apps
     WHERE org_id = $1
       AND slug = $2
       AND deleted_at IS NULL
       AND suspended_at IS NULL
       AND fly_app_id IS NULL
       AND EXISTS (
         SELECT 1 FROM deployments WHERE app_id = apps.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM deployments
         WHERE app_id = apps.id
           AND status != 'failed'
       )`,
    [orgId, slug],
  );
  return rows[0]?.id ?? null;
}

interface CreateDeployResult {
  deploymentId: string;
  appId: string;
}

async function createAppAndDeployment(
  orgId: string,
  userId: string | null,
  appName: string,
  explicitName: boolean,
  sourceType: "zip" | "github",
  sourceRef: string | null,
  existingAppId?: string,
): Promise<CreateDeployResult> {
  let appId!: string; // definite assignment: all branches assign or throw

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
    const baseSlug = slugify(appName);

    if (explicitName) {
      // User explicitly chose a name — 409 if already taken by an active app
      try {
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO apps (org_id, owner_id, name, slug, source_type, source_ref)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [orgId, userId, appName, baseSlug, sourceType, sourceRef],
        );
        appId = rows[0].id;
      } catch (err) {
        if (isPgUniqueViolation(err)) throw new NameTakenError(appName);
        throw err;
      }
    } else {
      // Auto-derived name — retry up to 5 times with a random suffix on collision
      let inserted = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        const suffix = attempt === 0 ? "" : `-${randomSuffix()}`;
        const slug = `${baseSlug.slice(0, 45)}${suffix}`;
        const name = suffix ? `${appName}${suffix}` : appName;
        try {
          const { rows } = await pool.query<{ id: string }>(
            `INSERT INTO apps (org_id, owner_id, name, slug, source_type, source_ref)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [orgId, userId, name, slug, sourceType, sourceRef],
          );
          appId = rows[0].id;
          inserted = true;
          break;
        } catch (err) {
          if (isPgUniqueViolation(err) && attempt < 4) continue;
          throw err;
        }
      }
      if (!inserted) throw new Error("app_not_found"); // never reached; satisfies TS
    }
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
  requireScope("deploy"),
  limitedUpload,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "validation_error", message: "Field 'code' (zip file) is required." });
      return;
    }

    // Compute name early — needed for reuse check before limit check
    const rawName = ((req.body as { app_name?: string }).app_name ?? "").trim();
    const appName = rawName || "app";
    const explicitName = rawName.length > 0;

    const orgId = await resolveOrgId(req);
    if (!orgId) {
      res.status(400).json({ error: "no_active_org" });
      return;
    }

    const existingAppId = (req.body as { app_id?: string }).app_id;
    // Check for a failed-first-deploy app that can be reused (before limit check)
    const reuseAppId = existingAppId
      ? null
      : await findReuseableApp(orgId, slugify(appName));
    const effectiveAppId = existingAppId ?? reuseAppId ?? undefined;

    // Check limits (skip app limit if redeploying or reusing a failed app)
    const violation = await checkDeployLimits(orgId, { skipAppLimit: !!effectiveAppId });
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

    // Refuse redeployment of a suspended app before any Fly call
    // (reuseAppId is already filtered to suspended_at IS NULL by findReuseableApp)
    if (existingAppId) {
      const { rows: suspRows } = await pool.query<{ suspended_at: Date | null }>(
        "SELECT suspended_at FROM apps WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL",
        [existingAppId, orgId],
      );
      if (suspRows[0] && suspRows[0].suspended_at !== null) {
        res.status(423).json({
          error: "app_suspended",
          message: "This app is suspended. Contact the platform admin.",
        });
        return;
      }
    }

    const userId = await resolveUserId(req);

    let deploymentId: string;
    let appId: string;

    try {
      ({ deploymentId, appId } = await createAppAndDeployment(
        orgId, userId, appName, explicitName, "zip", null, effectiveAppId,
      ));
    } catch (err) {
      if (err instanceof NameTakenError) {
        res.status(409).json({
          error: "name_taken",
          message: `An app named '${err.appName}' already exists in your org. Choose a different name.`,
        });
        return;
      }
      if (err instanceof Error && err.message === "app_not_found") {
        res.status(404).json({ error: "app_not_found" });
        return;
      }
      throw err;
    }

    // Grant creator access on new-app creation (not on redeployment or reuse)
    if (!effectiveAppId && userId) {
      await pool.query(
        `INSERT INTO app_access (app_id, user_id, granted_by)
         VALUES ($1, $2, NULL)
         ON CONFLICT DO NOTHING`,
        [appId, userId],
      );
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

intakeRouter.post("/github", requireScope("deploy"), asyncHandler(async (req: Request, res: Response) => {
  const { github_url, app_id: existingAppId, app_name } = req.body as {
    github_url?: string;
    app_id?: string;
    app_name?: string;
  };

  if (!github_url?.trim()) {
    res.status(400).json({ error: "validation_error", message: "Field 'github_url' is required." });
    return;
  }

  // Strict URL validation — returns { owner, repo, cloneUrl } or throws GithubUrlError
  let parsedGithub: { owner: string; repo: string; cloneUrl: string };
  try {
    parsedGithub = parseGithubUrl(github_url);
  } catch (err) {
    if (err instanceof GithubUrlError) {
      res.status(400).json({ error: "invalid_github_url", message: err.message });
      return;
    }
    throw err;
  }

  // Compute name early — needed for reuse check before limit check
  const rawName = (app_name ?? "").trim();
  const appName = rawName || parsedGithub.repo;
  const explicitName = rawName.length > 0;

  const orgId = await resolveOrgId(req);
  if (!orgId) {
    res.status(400).json({ error: "no_active_org" });
    return;
  }

  // Check for a failed-first-deploy app that can be reused (before limit check)
  const reuseAppId = existingAppId
    ? null
    : await findReuseableApp(orgId, slugify(appName));
  const effectiveAppId = existingAppId ?? reuseAppId ?? undefined;

  // Check limits (skip app limit if redeploying or reusing a failed app)
  const violation = await checkDeployLimits(orgId, { skipAppLimit: !!effectiveAppId });
  if (violation) {
    res.status(429).json({ error: violation.limit, message: violation.message });
    return;
  }

  // Refuse redeployment of a suspended app before any Fly call
  // (reuseAppId is already filtered to suspended_at IS NULL by findReuseableApp)
  if (existingAppId) {
    const { rows: suspRows } = await pool.query<{ suspended_at: Date | null }>(
      "SELECT suspended_at FROM apps WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL",
      [existingAppId, orgId],
    );
    if (suspRows[0] && suspRows[0].suspended_at !== null) {
      res.status(423).json({
        error: "app_suspended",
        message: "This app is suspended. Contact the platform admin.",
      });
      return;
    }
  }

  const userId = await resolveUserId(req);

  let deploymentId: string;
  let appId: string;

  try {
    ({ deploymentId, appId } = await createAppAndDeployment(
      orgId, userId, appName, explicitName, "github", parsedGithub.cloneUrl, effectiveAppId,
    ));
  } catch (err) {
    if (err instanceof NameTakenError) {
      res.status(409).json({
        error: "name_taken",
        message: `An app named '${err.appName}' already exists in your org. Choose a different name.`,
      });
      return;
    }
    if (err instanceof Error && err.message === "app_not_found") {
      res.status(404).json({ error: "app_not_found" });
      return;
    }
    throw err;
  }

  // Grant creator access on new-app creation (not on redeployment or reuse)
  if (!effectiveAppId && userId) {
    await pool.query(
      `INSERT INTO app_access (app_id, user_id, granted_by)
       VALUES ($1, $2, NULL)
       ON CONFLICT DO NOTHING`,
      [appId, userId],
    );
  }

  // Kick off deploy in background — use the canonical cloneUrl, not raw input
  setImmediate(() => {
    runDeploy({ deploymentId, appId, githubUrl: parsedGithub.cloneUrl }).catch((e) =>
      console.error("[intake] runDeploy error:", safeErr(e)),
    );
  });

  res.status(202).json({
    deployment_id: deploymentId,
    app_id: appId,
    stream_url: `/v1/deployments/${deploymentId}/stream`,
  });
}));
