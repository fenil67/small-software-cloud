import { EventEmitter } from "events";

export type DeployEvent =
  | { type: "log"; message: string }
  | { type: "status"; status: "queued" | "building" | "deploying" | "success" | "failed" }
  | { type: "url"; url: string }
  | { type: "error"; stage: string; message: string }
  | { type: "done" };

class DeployEventBus {
  private emitters = new Map<string, EventEmitter>();

  getOrCreate(deploymentId: string): EventEmitter {
    if (!this.emitters.has(deploymentId)) {
      const emitter = new EventEmitter();
      emitter.setMaxListeners(20);
      this.emitters.set(deploymentId, emitter);
    }
    return this.emitters.get(deploymentId)!;
  }

  emit(deploymentId: string, event: DeployEvent): void {
    this.emitters.get(deploymentId)?.emit("event", event);
    if (event.type === "done") {
      setTimeout(() => this.emitters.delete(deploymentId), 60_000);
    }
  }
}

export const eventBus = new DeployEventBus();
