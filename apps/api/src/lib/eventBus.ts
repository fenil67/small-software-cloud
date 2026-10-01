/**
 * In-process SSE event bus.
 *
 * Each in-flight deployment gets one EventEmitter. The SSE route subscribes to
 * it; the deploy runner emits onto it. No Redis needed for Phase 1 — this works
 * because Railway runs a single API instance. When we add multiple replicas or
 * horizontal scale, swap this for Redis pub/sub behind the same interface.
 */
import { EventEmitter } from "events";

export type DeployEvent =
  | { type: "log"; message: string }
  | { type: "status"; status: "queued" | "building" | "deploying" | "success" | "failed" }
  | { type: "url"; url: string }
  | { type: "error"; message: string }
  | { type: "done" };

const bus = new Map<string, EventEmitter>();

export const eventBus = {
  /** Get or create the emitter for a deployment. */
  getOrCreate(deploymentId: string): EventEmitter {
    if (!bus.has(deploymentId)) {
      const em = new EventEmitter();
      em.setMaxListeners(20);
      bus.set(deploymentId, em);
    }
    return bus.get(deploymentId)!;
  },

  emit(deploymentId: string, event: DeployEvent): void {
    bus.get(deploymentId)?.emit("event", event);
  },

  /** Remove the emitter once all subscribers have disconnected. */
  cleanup(deploymentId: string): void {
    bus.get(deploymentId)?.removeAllListeners();
    bus.delete(deploymentId);
  },
};
