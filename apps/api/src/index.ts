import "dotenv/config";
import { execFileSync } from "child_process";
import { gitEnv, flyctlEnv } from "./lib/childEnv";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { clerkMiddleware } from "@clerk/express";
import { safeErr } from "./lib/safeErr";
import { requestIdMiddleware, errorHandlerMiddleware } from "./middleware/errorHandler";

// ─── Process-level safety nets ────────────────────────────────────────────────
// These are last-resort guards so no unhandled rejection or uncaught exception
// can terminate the process.  Individual async handlers should still call
// next(err) — these catch anything that leaks through.
process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandledRejection", safeErr(reason));
});
process.on("uncaughtException", (err) => {
  console.error("[process] uncaughtException", safeErr(err));
});

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
})();

import { healthRouter } from "./routes/health";
import { appsRouter } from "./routes/apps";
import { orgsRouter } from "./routes/orgs";
import { apiKeysRouter } from "./routes/apiKeys";
import { authRouter } from "./routes/auth";
import { intakeRouter } from "./routes/intake";
import { deployStreamRouter } from "./routes/deployStream";
import { deploymentsRouter } from "./routes/deployments";
import { startReaper } from "./lib/reaper";

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
app.use("/v1/apps", appsRouter);
app.use("/v1/orgs", orgsRouter);
app.use("/v1/api-keys", apiKeysRouter);
app.use("/v1/deployments/intake", intakeRouter);
app.use("/v1/deployments", deployStreamRouter);
app.use("/v1/deployments", deploymentsRouter);

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
