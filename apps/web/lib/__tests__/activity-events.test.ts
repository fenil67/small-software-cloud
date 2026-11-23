/**
 * Tests for activity-events.ts
 *
 * M1 kill (appName): "uses app_name when present" — appName() must check e.app_name first
 * M2 kill (appName): "uses metadata.app_name as legacy fallback" — fallback chain must be ordered
 * M3 kill (appName): "uses 8-char short id when both are missing" — must not expose full UUID
 */

import { describe, it, expect } from "vitest";
import { EVENT_META } from "../activity-events";
import type { ActivityEventFields } from "../activity-events";
import activityFixture from "./fixtures/activity.json";
import type { ActivityListResponse } from "../api-types";

// ── Helper: build a minimal ActivityEventFields ────────────────────────────────

function makeEvent(overrides: Partial<ActivityEventFields>): ActivityEventFields {
  return {
    event_type: "app.visit",
    actor_email: null,
    actor_type: "user",
    target_id: null,
    app_id: null,
    app_name: null,
    metadata: {},
    ...overrides,
  };
}

// ── appName() — tested via sentence() ─────────────────────────────────────────

describe("appName()", () => {
  it("uses app_name when present (M1 kill: check app_name first)", () => {
    const e = makeEvent({
      app_name: "Live App",
      app_id: "12345678-0000-0000-0000-000000000000",
      metadata: { app_name: "Should Not Use This" },
    });
    const sentence = EVENT_META["app.visit"].sentence(e);
    expect(sentence).toContain("Live App");
    expect(sentence).not.toContain("12345678"); // must not fall back to UUID
    expect(sentence).not.toContain("Should Not Use This");
  });

  it("uses metadata.app_name as legacy fallback when app_name is null (M2 kill)", () => {
    const e = makeEvent({
      app_name: null,
      app_id: "12345678-0000-0000-0000-000000000000",
      metadata: { app_name: "Legacy App Name" },
    });
    const sentence = EVENT_META["app.visit"].sentence(e);
    expect(sentence).toContain("Legacy App Name");
    expect(sentence).not.toContain("12345678");
  });

  it("uses 8-char short id when both app_name and metadata.app_name are missing (M3 kill)", () => {
    const e = makeEvent({
      app_name: null,
      app_id: "abcdef12-0000-0000-0000-000000000000",
      metadata: {},
    });
    const sentence = EVENT_META["app.visit"].sentence(e);
    // Should show short id (first 8 chars), not the full UUID
    expect(sentence).toContain("abcdef12");
    expect(sentence).not.toContain("abcdef12-0000"); // full UUID must not appear
  });

  it("shows the full '(deleted)' suffix as given from app_name", () => {
    const e = makeEvent({
      app_name: "Gone App (deleted)",
      app_id: "12345678-0000-0000-0000-000000000000",
      metadata: {},
    });
    const sentence = EVENT_META["app.visit"].sentence(e);
    expect(sentence).toContain("Gone App (deleted)");
  });

  it("falls back to 'an app' when app_id is also null", () => {
    const e = makeEvent({ app_name: null, app_id: null, metadata: {} });
    const sentence = EVENT_META["app.visit"].sentence(e);
    expect(sentence).toContain("an app");
  });
});

// ── member event sentences ────────────────────────────────────────────────────

describe("member event sentences", () => {
  it("member.invited includes invitee email and role label", () => {
    const e = makeEvent({
      event_type: "member.invited",
      actor_email: "admin@example.com",
      metadata: { invitee_email: "user@example.com", role: "org:member" },
    });
    const sentence = EVENT_META["member.invited"].sentence(e);
    expect(sentence).toContain("admin@example.com");
    expect(sentence).toContain("user@example.com");
    expect(sentence).toContain("Member");
  });

  it("member.invited shows Admin role label for org:admin", () => {
    const e = makeEvent({
      event_type: "member.invited",
      actor_email: "admin@example.com",
      metadata: { invitee_email: "boss@example.com", role: "org:admin" },
    });
    const sentence = EVENT_META["member.invited"].sentence(e);
    expect(sentence).toContain("Admin");
    expect(sentence).not.toContain("org:admin");
  });

  it("member.invitation_revoked includes invitee email", () => {
    const e = makeEvent({
      event_type: "member.invitation_revoked",
      actor_email: "admin@example.com",
      metadata: { invitee_email: "user@example.com" },
    });
    const sentence = EVENT_META["member.invitation_revoked"].sentence(e);
    expect(sentence).toContain("admin@example.com");
    expect(sentence).toContain("user@example.com");
  });

  it("member.role_changed includes new role label", () => {
    const e = makeEvent({
      event_type: "member.role_changed",
      actor_email: "admin@example.com",
      metadata: { old_role: "org:member", new_role: "org:admin" },
    });
    const sentence = EVENT_META["member.role_changed"].sentence(e);
    expect(sentence).toContain("admin@example.com");
    expect(sentence).toContain("Admin");
    expect(sentence).not.toContain("org:admin");
  });

  it("member.removed includes actor", () => {
    const e = makeEvent({
      event_type: "member.removed",
      actor_email: "admin@example.com",
      metadata: { removed_role: "org:member" },
    });
    const sentence = EVENT_META["member.removed"].sentence(e);
    expect(sentence).toContain("admin@example.com");
    expect(sentence).toContain("workspace");
  });

  it("member.left includes actor", () => {
    const e = makeEvent({
      event_type: "member.left",
      actor_email: "user@example.com",
      metadata: { left_role: "org:member" },
    });
    const sentence = EVENT_META["member.left"].sentence(e);
    expect(sentence).toContain("user@example.com");
    expect(sentence).toContain("left");
  });

  it("all 5 member event types are present in EVENT_META", () => {
    const events = ["member.invited", "member.invitation_revoked", "member.role_changed", "member.removed", "member.left"];
    for (const ev of events) {
      expect(EVENT_META[ev]).toBeDefined();
      expect(EVENT_META[ev].chip).toBe("People");
    }
  });
});

// ── activity.json fixture contract ────────────────────────────────────────────

describe("activity fixture contract", () => {
  const fixture = activityFixture as ActivityListResponse;

  it("fixture has events array and next_cursor", () => {
    expect(Array.isArray(fixture.events)).toBe(true);
    expect("next_cursor" in fixture).toBe(true);
  });

  it("live-app event has app_name='Live App'", () => {
    const ev = fixture.events.find((e) => e.id === "11111111-0000-0000-0000-000000000001");
    expect(ev).toBeDefined();
    expect(ev!.app_name).toBe("Live App");
  });

  it("deleted-app event has app_name='Gone App (deleted)'", () => {
    const ev = fixture.events.find((e) => e.id === "11111111-0000-0000-0000-000000000002");
    expect(ev).toBeDefined();
    expect(ev!.app_name).toBe("Gone App (deleted)");
  });

  it("no-app event has app_name=null", () => {
    const ev = fixture.events.find((e) => e.id === "11111111-0000-0000-0000-000000000003");
    expect(ev).toBeDefined();
    expect(ev!.app_name).toBeNull();
  });
});
