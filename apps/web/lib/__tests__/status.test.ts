import { describe, it, expect } from "vitest";
import { resolveAppStatus } from "../status";

describe("resolveAppStatus", () => {
  it("Suspended trumps everything", () => {
    expect(resolveAppStatus(true, "running", "success")).toBe("Suspended");
    expect(resolveAppStatus(true, "running", "building")).toBe("Suspended");
    expect(resolveAppStatus(true, "failed", "failed")).toBe("Suspended");
    expect(resolveAppStatus(true, "sleeping", null)).toBe("Suspended");
  });

  it("Deploying when latest deploy is in-progress", () => {
    expect(resolveAppStatus(false, "building", "queued")).toBe("Deploying");
    expect(resolveAppStatus(false, "building", "building")).toBe("Deploying");
    expect(resolveAppStatus(false, "running", "deploying")).toBe("Deploying");
  });

  it("Failed when latest deploy failed", () => {
    expect(resolveAppStatus(false, "running", "failed")).toBe("Failed");
  });

  it("Failed when app status is failed and no deploy", () => {
    expect(resolveAppStatus(false, "failed", null)).toBe("Failed");
  });

  it("Sleeping when app status is sleeping", () => {
    expect(resolveAppStatus(false, "sleeping", null)).toBe("Sleeping");
    expect(resolveAppStatus(false, "sleeping", "success")).toBe("Sleeping");
  });

  it("Live for running app with successful deploy", () => {
    expect(resolveAppStatus(false, "running", "success")).toBe("Live");
  });

  it("Live for pending app with no deployment yet", () => {
    expect(resolveAppStatus(false, "pending", null)).toBe("Live");
  });

  it("Live for stopped app with no deployment", () => {
    expect(resolveAppStatus(false, "stopped", null)).toBe("Live");
  });

  it("Live when latest deploy was cancelled", () => {
    expect(resolveAppStatus(false, "running", "cancelled")).toBe("Live");
  });
});
