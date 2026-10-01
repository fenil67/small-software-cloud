/**
 * SSE stream for deployment progress.
 *
 * GET /v1/deployments/:id/stream
 *
 * No auth required — the deployment ID is an unguessable UUID.
 * Clients receive a stream of JSON events until the deploy finishes.
 *
 * Event format (Server-Sent Events):
 *   data: {"type":"log","message":"…"}\n\n
 *   data: {"type":"status","status":"building"}\n\n
 *   data: {"type":"url","url":"https://…"}\n\n
 *   data: {"type":"error","message":"…"}\n\n
 *   data: {"type":"done"}\n\n
 */

import { Router, Request, Response } from "express";
import { pool } from "../db";
import { eventBus } from "../lib/eventBus";

export const deployStreamRouter = Router();

const PING_INTERVAL_MS = 15_000;

deployStreamRouter.get("/:id/stream", async (req: Request, res: Response) => {
  const { id } = req.params;

  // Verify the deployment exists before opening the stream
  const { rows } = await pool.query<{ status: string }>(
    "SELECT status FROM deployments WHERE id = $1",
    [id]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "deployment_not_found" });
    return;
  }

  // If already finished, return the final status immediately and close
  const terminalStatuses = new Set(["success", "failed"]);
  if (terminalStatuses.has(rows[0].status)) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.write(`data: ${JSON.stringify({ type: "status", status: rows[0].status })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();
    return;
  }

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Disable nginx/proxy buffering so events flow immediately
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const emitter = eventBus.getOrCreate(id);

  // Keep-alive ping so proxies don't close idle connections
  const ping = setInterval(() => {
    res.write(": ping\n\n");
  }, PING_INTERVAL_MS);

  function onEvent(event: unknown) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);

    // Close the SSE connection after the terminal event
    if (
      event !== null &&
      typeof event === "object" &&
      "type" in event &&
      (event as { type: string }).type === "done"
    ) {
      cleanup();
      res.end();
    }
  }

  function cleanup() {
    clearInterval(ping);
    emitter.off("event", onEvent);
  }

  emitter.on("event", onEvent);

  // Client disconnected (browser tab closed, etc.)
  req.on("close", cleanup);
});
