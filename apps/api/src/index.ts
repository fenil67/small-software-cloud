import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { clerkMiddleware } from "@clerk/express";

import { healthRouter } from "./routes/health";
import { appsRouter } from "./routes/apps";
import { orgsRouter } from "./routes/orgs";
import { intakeRouter } from "./routes/intake";
import { deployStreamRouter } from "./routes/deployStream";
import { deploymentsRouter } from "./routes/deployments";

const app = express();
const PORT = process.env.API_PORT ? parseInt(process.env.API_PORT) : 4000;

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
app.use("/v1/apps", appsRouter);
app.use("/v1/orgs", orgsRouter);
app.use("/v1/deployments/intake", intakeRouter);
app.use("/v1/deployments", deployStreamRouter);
app.use("/v1/deployments", deploymentsRouter);

// ─── 404 fallback ────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

app.listen(PORT, () => {
  console.log(`[api] listening on http://localhost:${PORT}`);
});

export default app;
