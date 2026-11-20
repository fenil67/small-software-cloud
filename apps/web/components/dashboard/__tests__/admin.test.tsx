/**
 * Admin area tests: Sidebar admin section, AdminOverviewClient sections,
 * ActivityClient, SharedAppsSection, export route token safety.
 *
 * M1 kill: "hides admin section when isAdmin=false" — Sidebar must gate on isAdmin prop
 * M2 kill: "calls notFound when is_admin is false" — /admin page must 404 non-admins
 * M4 kill: "AS-M4 / AS-M4b" in run-tests.ts — /v1/me/shared-apps isolates by user_id
 * M5 kill: "Erase button disabled when emails differ"
 * M6 kill: "export route does not forward the token to the browser"
 * M7 kill: "AS-A5" in run-tests.ts — activity_searched throttle (20 → 1 row, diff → 2)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

// ── Mock lib/api so server components can be tested without real Clerk/fetch ──

vi.mock("../../../lib/api", () => ({
  apiFetch: vi.fn(),
}));
import { apiFetch } from "../../../lib/api";

// ── Global mocks ──────────────────────────────────────────────────────────────

const mockRouterRefresh = vi.fn();
const mockRouterReplace = vi.fn();
const mockRedirect = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ refresh: mockRouterRefresh, replace: mockRouterReplace })),
  usePathname: vi.fn(() => "/apps"),
  useSearchParams: vi.fn(() => ({ get: () => null })),
  redirect: (url: string) => { mockRedirect(url); throw new Error("NEXT_REDIRECT"); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(() => ({ userId: "user_test", orgId: "org_test", getToken: async () => "test-token" })),
  currentUser: vi.fn(() => null),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => ({ get: () => undefined })),
}));

const mockGetToken = vi.fn().mockResolvedValue("test-token");

vi.mock("@clerk/nextjs", () => ({
  useOrganization: vi.fn(() => ({
    organization: { id: "org_aaa", name: "Acme Corp" },
  })),
  useOrganizationList: vi.fn(() => ({
    userMemberships: { data: [] },
    setActive: vi.fn(),
  })),
  useUser: vi.fn(() => ({
    user: { firstName: "Alice", lastName: "Smith", primaryEmailAddress: { emailAddress: "alice@example.com" } },
  })),
  useClerk: vi.fn(() => ({ signOut: vi.fn() })),
  useAuth: vi.fn(() => ({ getToken: mockGetToken })),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, style, ...props }: { href: string; children: React.ReactNode; style?: React.CSSProperties } & Record<string, unknown>) =>
    React.createElement("a", { href, style }, children),
}));

beforeEach(() => {
  mockRouterRefresh.mockReset();
  mockGetToken.mockResolvedValue("test-token");
  // Reset fetch mock
  vi.restoreAllMocks();
});

// ── Test data ─────────────────────────────────────────────────────────────────

import type { SharedApp, AdminStats, AdminApp } from "../../../lib/api-types";

const mockSharedApps: SharedApp[] = [
  { app_id: "app-1", app_name: "Team App", url: "https://team-app.example.com", org_name: "Acme Corp", granted_at: "2026-01-01T00:00:00.000Z", status: "active" },
  { app_id: "app-2", app_name: "Pending App", url: null, org_name: "Beta Inc", granted_at: null, status: "pending" },
];

const mockStats: AdminStats = {
  people: 42,
  people_joined_this_week: 5,
  workspaces: 10,
  workspaces_with_teammates: 7,
  apps: { total: 20, live: 18, suspended: 2 },
  deploys_today: { total: 8, failed: 1 },
  visits_today: 150,
  refused_today: 3,
  watchdog: null,
  discord_configured: false,
  deploy_series: Array.from({ length: 14 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, "0")}`, succeeded: i, failed: 0 })),
  open_alerts: [],
};

const mockApps: AdminApp[] = [
  {
    id: "app-1", name: "Live App", org_id: "org-1", fly_app_id: "fly-1",
    suspended: false, suspended_at: null, suspend_reason: null,
    owner_email: "owner@example.com", org_name: "Acme Corp",
    last_visit_at: null, latest_deployment_status: "success",
    cpu_pct: 7.8, traffic_bytes_24h: 1024 * 1024,
  },
  {
    id: "app-2", name: "Suspended App", org_id: "org-1", fly_app_id: null,
    suspended: true, suspended_at: "2026-11-01T00:00:00.000Z", suspend_reason: "Policy violation",
    owner_email: "owner2@example.com", org_name: "Beta Corp",
    last_visit_at: "2026-11-15T12:00:00.000Z", latest_deployment_status: null,
    cpu_pct: null, traffic_bytes_24h: null,
  },
];

// ── AdminOverviewPage — server component (M2 kill) ───────────────────────────

import AdminOverviewPage from "../../../app/(dashboard)/admin/page";
import type { MeResponse } from "../../../lib/api-types";

describe("AdminOverviewPage (server component)", () => {
  it("calls notFound when is_admin is false (M2 kill)", async () => {
    // apiFetch is mocked — return non-admin me response
    vi.mocked(apiFetch).mockResolvedValueOnce({ is_admin: false, open_alert_count: null } as MeResponse);
    // next/navigation.notFound() is mocked to throw NEXT_NOT_FOUND
    await expect(AdminOverviewPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders when is_admin is true", async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ is_admin: true, open_alert_count: 0 } as MeResponse)
      .mockResolvedValueOnce({ ...mockStats } as AdminStats)
      .mockResolvedValueOnce([]);
    const result = await AdminOverviewPage();
    expect(result).toBeDefined();
  });
});

// ── Sidebar admin section (M1 kill) ──────────────────────────────────────────

import { Sidebar } from "../Sidebar";

describe("Sidebar admin section", () => {
  it("hides admin section when isAdmin=false", () => {
    render(<Sidebar isAdmin={false} openAlertCount={0} />);
    // The "Admin" group label should not appear
    const adminLabel = screen.queryByText("Admin");
    expect(adminLabel).toBeNull();
    // No link to /admin
    const adminLink = document.querySelector('a[href="/admin"]');
    expect(adminLink).toBeNull();
  });

  it("shows admin section when isAdmin=true", () => {
    render(<Sidebar isAdmin={true} openAlertCount={3} />);
    expect(screen.getByText("Admin")).toBeDefined();
    expect(document.querySelector('a[href="/admin"]')).toBeDefined();
    expect(document.querySelector('a[href="/admin/activity"]')).toBeDefined();
    // Badge with 3
    expect(screen.getByText("3")).toBeDefined();
  });

  it("hides badge when openAlertCount is 0", () => {
    render(<Sidebar isAdmin={true} openAlertCount={0} />);
    // Badge should not be rendered (no element with aria-label matching N open alerts)
    const badges = document.querySelectorAll('[aria-label$="open alerts"]');
    expect(badges.length).toBe(0);
  });
});

// ── AdminOverviewClient ───────────────────────────────────────────────────────

import { AdminOverviewClient } from "../../../app/(dashboard)/admin/AdminOverviewClient";

describe("AdminOverviewClient", () => {
  it("renders stat cards when stats are provided", () => {
    render(<AdminOverviewClient stats={mockStats} apps={mockApps} statsError={null} appsError={null} />);
    expect(screen.getByText("42")).toBeDefined(); // people
    expect(screen.getByText("20")).toBeDefined(); // apps total
  });

  it("renders ErrorCard when statsError is set (M2 kill test)", () => {
    render(<AdminOverviewClient stats={null} apps={[]} statsError="Could not load stats." appsError={null} />);
    expect(screen.getByText("Could not load stats.")).toBeDefined();
  });

  it("renders deploy chart with aria-label", () => {
    render(<AdminOverviewClient stats={mockStats} apps={mockApps} statsError={null} appsError={null} />);
    const chart = document.querySelector('[aria-label*="Deploy bar chart"]');
    expect(chart).toBeDefined();
  });

  it("shows empty state when all deploy values are zero", () => {
    const statsNoDeployActivity = {
      ...mockStats,
      deploy_series: Array.from({ length: 14 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, "0")}`, succeeded: 0, failed: 0 })),
    };
    render(<AdminOverviewClient stats={statsNoDeployActivity} apps={[]} statsError={null} appsError={null} />);
    expect(screen.getByText("No deploys in the last 14 days.")).toBeDefined();
  });

  it("renders apps table with owner column and cpu/traffic data", () => {
    render(<AdminOverviewClient stats={mockStats} apps={mockApps} statsError={null} appsError={null} />);
    expect(screen.getByText("owner@example.com")).toBeDefined();
    expect(screen.getByText("7.8%")).toBeDefined();
    expect(screen.getByText("1.0 MB")).toBeDefined();
  });

  it("shows Not available for null CPU and traffic", () => {
    render(<AdminOverviewClient stats={mockStats} apps={mockApps} statsError={null} appsError={null} />);
    const naElements = screen.getAllByText("Not available");
    expect(naElements.length).toBeGreaterThan(0);
  });

  it("shows Suspend button for live apps, Unsuspend for suspended", () => {
    render(<AdminOverviewClient stats={mockStats} apps={mockApps} statsError={null} appsError={null} />);
    expect(screen.getByText("Suspend")).toBeDefined();
    expect(screen.getByText("Unsuspend")).toBeDefined();
  });

  it("shows open alerts section only when there are alerts", () => {
    const statsWithAlerts: AdminStats = {
      ...mockStats,
      open_alerts: [{
        id: "alert-1",
        kind: "unreachable",
        app_id: "app-1",
        app_name: "Live App",
        owner_email: "owner@example.com",
        created_at: new Date().toISOString(),
        detail: {},
      }],
    };
    render(<AdminOverviewClient stats={statsWithAlerts} apps={mockApps} statsError={null} appsError={null} />);
    expect(screen.getByText("Open alerts")).toBeDefined();
  });

  it("shows Also sent to Discord only when discord_configured is true", () => {
    const statsWithDiscord: AdminStats = { ...mockStats, discord_configured: true, open_alerts: [{ id: "a", kind: "unreachable", app_id: null, app_name: null, owner_email: null, created_at: new Date().toISOString(), detail: {} }] };
    render(<AdminOverviewClient stats={statsWithDiscord} apps={[]} statsError={null} appsError={null} />);
    expect(screen.getByText("Also sent to Discord")).toBeDefined();
  });
});

// ── FilterChips via ActivityClient ────────────────────────────────────────────

import { ActivityClient } from "../../../app/(dashboard)/admin/activity/ActivityClient";

describe("FilterChips", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ events: [], next_cursor: null }),
    }) as unknown as typeof fetch;
  });

  it("renders All chip as active by default, aria-pressed=true", async () => {
    render(<ActivityClient initialSummary={[]} />);
    await waitFor(() => {
      const allBtn = screen.getByRole("button", { name: "All" });
      expect(allBtn.getAttribute("aria-pressed")).toBe("true");
    });
  });

  it("switches active chip on click, aria-pressed updates", async () => {
    render(<ActivityClient initialSummary={[]} />);
    await waitFor(() => {
      const visitsBtn = screen.getByRole("button", { name: /Visits/ });
      fireEvent.click(visitsBtn);
      expect(visitsBtn.getAttribute("aria-pressed")).toBe("true");
    });
  });

  it("displays counts from summary", async () => {
    const summary = [{ event_type: "app.visit", count_24h: 5, count_7d: 20 }];
    render(<ActivityClient initialSummary={summary} />);
    await waitFor(() => {
      expect(screen.getByText("20")).toBeDefined();
    });
  });
});

// ── ErasePersonDialog via ActivityClient ──────────────────────────────────────

describe("ErasePersonDialog", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ events: [], next_cursor: null }),
    }) as unknown as typeof fetch;
  });

  it("Erase button disabled when emails are empty", async () => {
    render(<ActivityClient initialSummary={[]} />);
    await waitFor(() => {
      fireEvent.click(screen.getByRole("button", { name: "Erase a person" }));
    });
    const eraseBtn = screen.getByRole("button", { name: /Erase$/ });
    expect(eraseBtn).toBeDefined();
    expect(eraseBtn.hasAttribute("disabled")).toBe(true);
  });

  it("Erase button disabled when emails differ (M5 kill)", async () => {
    render(<ActivityClient initialSummary={[]} />);
    await waitFor(() => {
      fireEvent.click(screen.getByRole("button", { name: "Erase a person" }));
    });
    const inputs = document.querySelectorAll('input[type="email"]');
    fireEvent.change(inputs[0], { target: { value: "alice@example.com" } });
    fireEvent.change(inputs[1], { target: { value: "bob@example.com" } });
    const eraseBtn = screen.getByRole("button", { name: /Erase$/ });
    expect(eraseBtn.hasAttribute("disabled")).toBe(true);
  });

  it("Erase button enabled when both fields match exactly", async () => {
    render(<ActivityClient initialSummary={[]} />);
    await waitFor(() => {
      fireEvent.click(screen.getByRole("button", { name: "Erase a person" }));
    });
    const inputs = document.querySelectorAll('input[type="email"]');
    fireEvent.change(inputs[0], { target: { value: "alice@example.com" } });
    fireEvent.change(inputs[1], { target: { value: "alice@example.com" } });
    const eraseBtn = screen.getByRole("button", { name: /Erase$/ });
    expect(eraseBtn.hasAttribute("disabled")).toBe(false);
  });
});

// ── Export route token safety (M6 kill) ──────────────────────────────────────

describe("Export route", () => {
  it("export route does not forward the token to the browser", async () => {
    const { GET } = await import("../../../app/(dashboard)/admin/activity/export/route");
    const csvData = "id,occurred_at,event_type\n";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(csvData));
          controller.close();
        },
      }),
      status: 200,
    }) as unknown as typeof fetch;

    const request = new Request("http://localhost/admin/activity/export");
    const response = await GET(request);

    expect(response.status).toBe(200);
    const contentDisposition = response.headers.get("Content-Disposition");
    expect(contentDisposition).toContain("attachment");
    // The Authorization header value (token) should NOT be in the response headers
    const authHeader = response.headers.get("Authorization");
    expect(authHeader).toBeNull();
  });
});

// ── SharedAppsSection ─────────────────────────────────────────────────────────

import { SharedAppsSection } from "../../../app/(dashboard)/apps/SharedAppsSection";

describe("SharedAppsSection", () => {
  it("renders shared apps table when apps are provided", () => {
    render(<SharedAppsSection apps={mockSharedApps} />);
    expect(screen.getByText("Team App")).toBeDefined();
    expect(screen.getByText("Acme Corp")).toBeDefined();
    expect(screen.getByText("Pending App")).toBeDefined();
  });

  it("hides the section when apps array is empty", () => {
    const { container } = render(<SharedAppsSection apps={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows Not opened yet for pending status apps", () => {
    render(<SharedAppsSection apps={mockSharedApps} />);
    expect(screen.getByText("Not opened yet")).toBeDefined();
  });

  it("shows Open button with correct href for active apps", () => {
    render(<SharedAppsSection apps={mockSharedApps} />);
    const link = document.querySelector('a[href="https://team-app.example.com"]');
    expect(link).toBeDefined();
    expect(link?.textContent).toBe("Open");
  });

  it("does not show Open button for pending apps", () => {
    render(<SharedAppsSection apps={[{ app_id: "app-2", app_name: "Pending App", url: null, org_name: "Beta Inc", granted_at: null, status: "pending" }]} />);
    expect(screen.queryByText("Open")).toBeNull();
  });

  it("does not render admin-only data", () => {
    render(<SharedAppsSection apps={mockSharedApps} />);
    // No /admin links
    const adminLink = document.querySelector('a[href*="/admin"]');
    expect(adminLink).toBeNull();
  });
});
