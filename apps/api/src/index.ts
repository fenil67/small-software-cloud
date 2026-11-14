import "dotenv/config";
import { execFileSync } from "child_process";
import { gitEnv, flyctlEnv } from "./lib/childEnv";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { clerkMiddleware } from "@clerk/express";
import { safeErr } from "./lib/safeErr";
import { installProcessHandlers } from "./lib/processHandlers";
import { requestIdMiddleware, errorHandlerMiddleware } from "./middleware/errorHandler";

// ─── Process-level safety nets ────────────────────────────────────────────────
// Last-resort guards: uncaughtException exits 1; unhandledRejection only logs.
installProcessHandlers();

// ─── Startup checks ──────────────────────────────────────────────────────────
// Crash loudly at boot if required env vars or binaries are missing rather
// than failing silently on the first deploy request.
(function startupChecks() {
  // Required env vars — check presence only, never log values
  const requiredEnv = ["FLY_API_TOKEN", "FLY_ORG_SLUG"];
  for (const key of requiredEnv) {
    if (!process.env[key]) {
      console.error(`[startup] FATAL: env var "${key}" is unset or empty.`);
      process.exit(1);
    }
  }

  // Required binaries
  const required: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[] = [
    { bin: "flyctl", args: ["version"], env: flyctlEnv() },
    { bin: "git",    args: ["--version"], env: gitEnv() },
  ];

  for (const { bin, args, env } of required) {
    try {
      const out = execFileSync(bin, args, { encoding: "utf8", env }).trim();
      console.log(`[startup] ${bin}: ${out.split("\n")[0]}`);
    } catch {
      console.error(`[startup] FATAL: "${bin}" not found or failed to run. Is it installed in this image?`);
      process.exit(1);
    }
  }

  // PROXY_IMAGE must be a digest-pinned registry.fly.io image
  const proxyImage = process.env.PROXY_IMAGE ?? "";
  if (!/^registry\.fly\.io\/[a-z0-9-]+@sha256:[0-9a-f]{64}$/.test(proxyImage)) {
    console.error(
      "[startup] FATAL: PROXY_IMAGE must be a digest-pinned registry.fly.io image " +
        "(e.g. registry.fly.io/my-proxy@sha256:<64-hex-chars>).",
    );
    process.exit(1);
  }

  // API_PUBLIC_URL must be https (http://localhost allowed when SSC_TEST=1)
  const apiPublicUrl = process.env.API_PUBLIC_URL ?? "";
  (() => {
    let parsed: URL;
    try { parsed = new URL(apiPublicUrl); } catch {
      console.error("[startup] FATAL: API_PUBLIC_URL is not a valid URL.");
      process.exit(1);
    }
    const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !(process.env.SSC_TEST === "1" && isLocalhost)) {
      console.error("[startup] FATAL: API_PUBLIC_URL must be an https URL (http://localhost is allowed when SSC_TEST=1).");
      process.exit(1);
    }
  })();

  // WEB_URL must be https outside SSC_TEST
  const webUrlCheck = process.env.WEB_URL ?? "";
  (() => {
    let parsed: URL;
    try { parsed = new URL(webUrlCheck); } catch {
      console.error("[startup] FATAL: WEB_URL is not a valid URL.");
      process.exit(1);
    }
    if (parsed.protocol !== "https:" && process.env.SSC_TEST !== "1") {
      console.error("[startup] FATAL: WEB_URL must be an https URL.");
      process.exit(1);
    }
  })();

})();

import { healthRouter } from "./routes/health";
import { appsRouter } from "./routes/apps";
import { appAccessRouter } from "./routes/appAccess";
import { orgsRouter } from "./routes/orgs";
import { apiKeysRouter } from "./routes/apiKeys";
import { authRouter } from "./routes/auth";
import { intakeRouter } from "./routes/intake";
import { deployStreamRouter } from "./routes/deployStream";
import { deploymentsRouter } from "./routes/deployments";
import { proxyRouter } from "./routes/proxy";
import { adminRouter, validateAdminConfig } from "./routes/admin";
import { startReaper } from "./lib/reaper";
import { validateWatchdogConfig } from "./lib/watchdog";

// PLATFORM_ADMIN_CLERK_IDS — optional; each entry must match ^user_[A-Za-z0-9]+$
// Called here, directly after the ./routes/admin import, so the compiled require()
// for that module has already run and validateAdminConfig is defined.
// (Calling it inside the earlier startupChecks IIFE caused a TDZ ReferenceError
// because TypeScript's CommonJS output places the require() in source order, not
// hoisted, so admin_1 was not yet initialised when the IIFE executed.)
validateAdminConfig();
// Watchdog config: ALERT_DISCORD_WEBHOOK_URL, WATCHDOG_CPU_CORES,
// WATCHDOG_EGRESS_BYTES_PER_SEC — same placement rule as above.
validateWatchdogConfig();

const app = express();
// Railway injects PORT; API_PORT is the local-dev fallback
const PORT = parseInt(process.env.PORT ?? process.env.API_PORT ?? "4000");

// ─── Request ID (must be first so every log and error response carries it) ───
app.use(requestIdMiddleware);

// ─── Security & logging ──────────────────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: process.env.WEB_URL ?? "http://localhost:3000",
    credentials: true,
  })
);
app.use(morgan("dev"));
app.use(express.json());

// ─── Clerk auth (attaches auth() to every request) ──────────────────────────
app.use(clerkMiddleware());

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use("/health", healthRouter);
app.use("/v1/auth", authRouter);
app.use("/v1/apps/:id/access", appAccessRouter);
app.use("/v1/apps", appsRouter);
app.use("/v1/orgs", orgsRouter);
app.use("/v1/api-keys", apiKeysRouter);
app.use("/v1/deployments/intake", intakeRouter);
app.use("/v1/deployments", deployStreamRouter);
app.use("/v1/deployments", deploymentsRouter);
app.use("/v1/proxy", proxyRouter);
app.use("/v1/admin", adminRouter);

// ─── 404 fallback ────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

// ─── Final error middleware ───────────────────────────────────────────────────
// Catches any error passed via next(err) or thrown synchronously in a handler.
// Async handlers in Express 4 do NOT automatically invoke this — they must
// call next(err) themselves.  The process.on("unhandledRejection") above is the
// safety net for anything that leaks without calling next(err).
app.use(errorHandlerMiddleware);

// ─── Background jobs ─────────────────────────────────────────────────────────
startReaper();

app.listen(PORT, () => {
  console.log(`[api] listening on http://localhost:${PORT}`);
});

export default app;
