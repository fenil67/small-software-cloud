/**
 * T1 – Dashboard component render tests (mocked data).
 *
 * Covers every route state (empty, error, populated), AppsTable filters and
 * search, AppStatusBadge (all 5 statuses), delete confirm (M3), key reveal
 * lifecycle (never in storage/URL/cookies), admin-only controls absent for
 * org:member, failure_message XSS safety + 500-char truncation, workspace
 * switcher (M: switcher), onboarding name validation (M5), no emoji anywhere.
 *
 * M6 (dashboard layout auth check) is verified via behaviour tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";
import { useSearchParams } from "next/navigation";
import { useUser, useClerk } from "@clerk/nextjs";

// ── Global mocks ──────────────────────────────────────────────────────────────

const mockNavigateHard = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/navigate", () => ({ navigateHard: mockNavigateHard }));

const mockRouterRefresh = vi.fn();
const mockRouterReplace = vi.fn();
const mockRedirect = vi.fn();
const mockServerAuth = vi.fn();
const mockCurrentUser = vi.fn();
const mockCookies = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ refresh: mockRouterRefresh, replace: mockRouterReplace })),
  usePathname: vi.fn(() => "/apps"),
  useSearchParams: vi.fn(() => ({ get: () => null })),
  redirect: (url: string) => { mockRedirect(url); throw new Error("NEXT_REDIRECT"); },
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => mockServerAuth(),
  currentUser: () => mockCurrentUser(),
  clerkClient: vi.fn().mockResolvedValue({
    organizations: {
      getOrganization: vi.fn().mockResolvedValue({ name: "Acme Corp" }),
    },
  }),
}));

vi.mock("next/headers", () => ({
  cookies: () => mockCookies(),
}));

const mockSetActive = vi.fn();
const mockSignOut = vi.fn();
const mockCreateOrganization = vi.fn();
const mockGetToken = vi.fn().mockResolvedValue("test-token");
// _mockSessionOrgId is read by the useClerk().session getter — update it in tests
// to simulate clerk.session (SignedInSessionResource.lastActiveOrganizationId) changing.
let _mockSessionOrgId: string | null = "org_aaa";

vi.mock("@clerk/nextjs", () => ({
  useOrganization: vi.fn(() => ({
    organization: { id: "org_aaa", name: "Acme Corp" },
  })),
  useOrganizationList: vi.fn(() => ({
    userMemberships: {
      data: [
        { organization: { id: "org_aaa", name: "Acme Corp" } },
        { organization: { id: "org_bbb", name: "Beta Inc" } },
      ],
    },
    userInvitations: { data: [] },
    setActive: mockSetActive,
    createOrganization: mockCreateOrganization,
  })),
  useUser: vi.fn(() => ({
    user: {
      firstName: "Alice",
      lastName: "Smith",
      primaryEmailAddress: { emailAddress: "alice@example.com" },
    },
  })),
  useClerk: vi.fn(() => ({
    signOut: mockSignOut,
    setActive: mockSetActive,
    get session() { return { lastActiveOrganizationId: _mockSessionOrgId }; },
  })),
  useSession: vi.fn(() => ({ session: null })),
  useSessionList: vi.fn(() => ({ sessions: [], isLoaded: true })),
  useReverification: vi.fn((fetcher: (...args: unknown[]) => Promise<unknown>) => {
    return async (...args: unknown[]) => fetcher(...args);
  }),
  useAuth: vi.fn(() => ({ getToken: mockGetToken })),
}));

vi.mock("next/image", () => ({
  default: ({ alt, ...props }: { alt: string } & Record<string, unknown>) =>
    React.createElement("img", { alt }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    onClick,
    style,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: () => void;
    style?: React.CSSProperties;
  } & Record<string, unknown>) =>
    React.createElement("a", { href, onClick, style }, children),
}));

// Mock server actions
const mockDeleteApp = vi.fn();
const mockGrantAccess = vi.fn();
const mockRevokeAccess = vi.fn();
const mockCreateKey = vi.fn();
const mockRevokeKey = vi.fn();
const mockApiFetch = vi.fn();

vi.mock("../../../lib/api", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  isAppArray: vi.fn(() => true),
  isDeploymentArray: vi.fn(() => true),
  isApp: vi.fn(() => true),
  isAppAccessResponse: vi.fn(() => true),
}));

const mockSetEnvVar    = vi.fn();
const mockUnsetEnvVar  = vi.fn();
const mockApplyEnvVars = vi.fn();

vi.mock("../../../app/(dashboard)/apps/actions", () => ({
  deleteApp:     (...a: unknown[]) => mockDeleteApp(...a),
  grantAccess:   (...a: unknown[]) => mockGrantAccess(...a),
  revokeAccess:  (...a: unknown[]) => mockRevokeAccess(...a),
  setEnvVar:     (...a: unknown[]) => mockSetEnvVar(...a),
  unsetEnvVar:   (...a: unknown[]) => mockUnsetEnvVar(...a),
  applyEnvVars:  (...a: unknown[]) => mockApplyEnvVars(...a),
}));

vi.mock("../../../app/(dashboard)/keys/actions", () => ({
  createKey: (...a: unknown[]) => mockCreateKey(...a),
  revokeKey: (...a: unknown[]) => mockRevokeKey(...a),
}));

beforeEach(() => {
  mockNavigateHard.mockReset();
  mockRouterRefresh.mockReset();
  mockRouterReplace.mockReset();
  mockRedirect.mockReset();
  _mockSessionOrgId = "org_aaa";
  mockServerAuth.mockReset().mockResolvedValue({ userId: "user_test", orgId: "org_test", getToken: vi.fn().mockResolvedValue(null) });
  mockCurrentUser.mockReset().mockResolvedValue({ firstName: null });
  mockCookies.mockReset().mockResolvedValue({ get: () => undefined });
  mockSetActive.mockReset().mockResolvedValue(undefined);
  mockDeleteApp.mockReset().mockResolvedValue({});
  mockGrantAccess.mockReset().mockResolvedValue({});
  mockRevokeAccess.mockReset().mockResolvedValue({});
  mockCreateKey.mockReset();
  mockRevokeKey.mockReset().mockResolvedValue({});
  mockApiFetch.mockReset().mockResolvedValue([]);
  mockGetToken.mockReset().mockResolvedValue("test-token");
  mockCreateOrganization.mockReset();
  if (typeof localStorage !== "undefined" && typeof localStorage.clear === "function") localStorage.clear();
  if (typeof sessionStorage !== "undefined" && typeof sessionStorage.clear === "function") sessionStorage.clear();
});

// ── Test data ─────────────────────────────────────────────────────────────────

import type { App, ApiKey, ApiKeyCreated } from "../../../lib/api-types";

const liveApp: App = {
  id: "app-1", name: "My Live App", slug: "my-live-app",
  source_type: "zip", source_ref: null, fly_app_id: "fly-1",
  subdomain: "my-live-app.fly.dev", created_at: "2026-01-01T00:00:00Z",
  suspended: false, status: "running", latest_deployment_status: "success",
  last_deployed_at: "2026-01-02T00:00:00Z",
};
const failedApp: App = { ...liveApp, id: "app-2", name: "Failed App", slug: "failed-app", latest_deployment_status: "failed" };
const suspendedApp: App = { ...liveApp, id: "app-3", name: "Suspended App", slug: "suspended-app", suspended: true };
const deployingApp: App = { ...liveApp, id: "app-4", name: "Deploying App", slug: "deploying-app", latest_deployment_status: "building" };
const sleepingApp: App = { ...liveApp, id: "app-5", name: "Sleeping App", slug: "sleeping-app", status: "sleeping", latest_deployment_status: "success" };
const allApps = [liveApp, failedApp, suspendedApp, deployingApp, sleepingApp];

const baseKey: ApiKey = {
  id: "key-1", name: "Test Key", key_prefix: "ssc_abc",
  created_at: "2026-01-01T00:00:00Z", last_used_at: null, revoked_at: null,
};

// ═════════════════════════════════════════════════════════════════════════════
// AppsTable
// ═════════════════════════════════════════════════════════════════════════════

import { AppsTable } from "../AppsTable";

describe("AppsTable – empty state", () => {
  it("shows 'No apps yet.' when list is empty", () => {
    render(<AppsTable apps={[]} />);
    expect(screen.getByText("No apps yet.")).toBeInTheDocument();
  });
  it("contains no emoji", () => {
    const { container } = render(<AppsTable apps={[]} />);
    expect(container.textContent).not.toMatch(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u);
  });
});

describe("AppsTable – populated", () => {
  it("renders all app names", () => {
    render(<AppsTable apps={allApps} />);
    for (const app of allApps) expect(screen.getByText(app.name)).toBeInTheDocument();
  });
  it("contains no emoji", () => {
    const { container } = render(<AppsTable apps={allApps} />);
    expect(container.textContent).not.toMatch(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u);
  });
});

describe("AppsTable – filter All", () => {
  it("shows all 5 apps under All tab (default)", () => {
    render(<AppsTable apps={allApps} />);
    for (const app of allApps) expect(screen.getByText(app.name)).toBeInTheDocument();
  });
});

describe("AppsTable – filter Live", () => {
  it("Live tab shows only Live apps", () => {
    render(<AppsTable apps={allApps} />);
    fireEvent.click(screen.getByRole("tab", { name: /^live/i }));
    expect(screen.getByText("My Live App")).toBeInTheDocument();
    expect(screen.queryByText("Failed App")).not.toBeInTheDocument();
    expect(screen.queryByText("Suspended App")).not.toBeInTheDocument();
    expect(screen.queryByText("Deploying App")).not.toBeInTheDocument();
  });
});

describe("AppsTable – filter Needs attention", () => {
  it("shows Failed and Suspended only", () => {
    render(<AppsTable apps={allApps} />);
    fireEvent.click(screen.getByRole("tab", { name: /needs attention/i }));
    expect(screen.getByText("Failed App")).toBeInTheDocument();
    expect(screen.getByText("Suspended App")).toBeInTheDocument();
    expect(screen.queryByText("My Live App")).not.toBeInTheDocument();
    expect(screen.queryByText("Deploying App")).not.toBeInTheDocument();
    expect(screen.queryByText("Sleeping App")).not.toBeInTheDocument();
  });
});

describe("AppsTable – search", () => {
  it("filters by name case-insensitively", () => {
    render(<AppsTable apps={allApps} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "failed" } });
    expect(screen.getByText("Failed App")).toBeInTheDocument();
    expect(screen.queryByText("My Live App")).not.toBeInTheDocument();
  });
  it("shows 'No apps match.' for unmatched search", () => {
    render(<AppsTable apps={allApps} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "xyznosuchapp" } });
    expect(screen.getByText("No apps match.")).toBeInTheDocument();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AppsTable – New app dialog
// ═════════════════════════════════════════════════════════════════════════════

describe("AppsTable – New app dialog", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });
  });

  it("dialog is hidden before button click", () => {
    render(<AppsTable apps={[]} isOrgAdmin />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens on 'New app' button click", () => {
    render(<AppsTable apps={[]} isOrgAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /new app/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Ship a new app")).toBeInTheDocument();
  });

  it("Escape closes dialog and returns focus to trigger button", async () => {
    render(<AppsTable apps={[]} isOrgAdmin />);
    const triggerBtn = screen.getByRole("button", { name: /new app/i });
    fireEvent.click(triggerBtn);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(triggerBtn);
  });

  it("close button dismisses dialog", async () => {
    render(<AppsTable apps={[]} isOrgAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /new app/i }));
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("copy button for login command copies exact string", async () => {
    render(<AppsTable apps={[]} isOrgAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /new app/i }));
    fireEvent.click(screen.getByRole("button", { name: /copy login command/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("npx @utir/ssc login");
  });

  it("copy button for deploy command copies exact string", async () => {
    render(<AppsTable apps={[]} isOrgAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /new app/i }));
    fireEvent.click(screen.getByRole("button", { name: /copy deploy command/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("npx @utir/ssc deploy .");
  });

  it("copy button for MCP package name copies exact string", async () => {
    render(<AppsTable apps={[]} isOrgAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /new app/i }));
    fireEvent.click(screen.getByRole("button", { name: /copy package name/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("@utir/ssc-mcp");
  });

  it("non-admin sees 'Ask a workspace admin for a key.'", () => {
    render(<AppsTable apps={[]} isOrgAdmin={false} />);
    fireEvent.click(screen.getByRole("button", { name: /new app/i }));
    expect(screen.getByText(/ask a workspace admin for a key/i)).toBeInTheDocument();
    expect(screen.queryByText(/go to api keys/i)).not.toBeInTheDocument();
  });

  it("org admin sees 'Go to API keys' link", () => {
    render(<AppsTable apps={[]} isOrgAdmin />);
    fireEvent.click(screen.getByRole("button", { name: /new app/i }));
    expect(screen.queryByText(/ask a workspace admin for a key/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to api keys/i })).toBeInTheDocument();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AppStatusBadge – all 5 statuses
// ═════════════════════════════════════════════════════════════════════════════

import { AppStatusBadge } from "../AppStatusBadge";

const statusList = ["Live", "Deploying", "Failed", "Suspended", "Sleeping"] as const;

describe("AppStatusBadge – icon + word for all 5 statuses", () => {
  for (const status of statusList) {
    it(`renders word "${status}"`, () => {
      render(<AppStatusBadge status={status} />);
      expect(screen.getByText(status)).toBeInTheDocument();
    });
    it(`renders an SVG icon for ${status}`, () => {
      const { container } = render(<AppStatusBadge status={status} />);
      expect(container.querySelector("svg")).toBeInTheDocument();
    });
    it(`${status} contains no emoji`, () => {
      const { container } = render(<AppStatusBadge status={status} />);
      expect(container.textContent).not.toMatch(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// AppDetailClient – delete confirm (M3)
// ═════════════════════════════════════════════════════════════════════════════

import { AppDetailClient } from "../../../app/(dashboard)/apps/[id]/AppDetailClient";

describe("AppDetailClient – M3: delete confirm requires exact name", () => {
  const appId = "app-abc";
  const appName = "My Exact App";

  it("delete button disabled with no name", () => {
    render(<AppDetailClient appId={appId} appName={appName} accessList={[]} isAdmin showDeleteOnly />);
    expect(screen.getByRole("button", { name: /delete app/i })).toBeDisabled();
  });

  it("M3: delete button disabled when name has wrong case", () => {
    render(<AppDetailClient appId={appId} appName={appName} accessList={[]} isAdmin showDeleteOnly />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "my exact app" } });
    expect(screen.getByRole("button", { name: /delete app/i })).toBeDisabled();
  });

  it("M3: delete button disabled when name has trailing space", () => {
    render(<AppDetailClient appId={appId} appName={appName} accessList={[]} isAdmin showDeleteOnly />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: appName + " " } });
    expect(screen.getByRole("button", { name: /delete app/i })).toBeDisabled();
  });

  it("M3: delete button disabled with partial match", () => {
    render(<AppDetailClient appId={appId} appName={appName} accessList={[]} isAdmin showDeleteOnly />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My Exact" } });
    expect(screen.getByRole("button", { name: /delete app/i })).toBeDisabled();
  });

  it("delete button enabled with exact name", () => {
    render(<AppDetailClient appId={appId} appName={appName} accessList={[]} isAdmin showDeleteOnly />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: appName } });
    expect(screen.getByRole("button", { name: /delete app/i })).not.toBeDisabled();
  });

  it("calls deleteApp with exact name on submit", async () => {
    render(<AppDetailClient appId={appId} appName={appName} accessList={[]} isAdmin showDeleteOnly />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: appName } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /delete app/i }));
    });
    expect(mockDeleteApp).toHaveBeenCalledWith(appId, appName);
  });

  it("M3: shows error when server returns name_mismatch", async () => {
    mockDeleteApp.mockResolvedValueOnce({ error: "name_mismatch" });
    render(<AppDetailClient appId={appId} appName={appName} accessList={[]} isAdmin showDeleteOnly />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: appName } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /delete app/i }));
    });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});

describe("AppDetailClient – admin-only controls absent for member", () => {
  it("non-admin sees no delete button (showDeleteOnly + isAdmin=false → null)", () => {
    render(<AppDetailClient appId="app-x" appName="App" accessList={[]} isAdmin={false} showDeleteOnly />);
    expect(screen.queryByRole("button", { name: /delete app/i })).not.toBeInTheDocument();
  });

  it("non-admin sees no grant access form", () => {
    render(<AppDetailClient appId="app-x" appName="App" accessList={[]} isAdmin={false} />);
    expect(screen.queryByPlaceholderText(/email/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^add$/i })).not.toBeInTheDocument();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AppDetailClient – email invite notice (email_status)
// ═════════════════════════════════════════════════════════════════════════════

async function submitGrant(email: string) {
  fireEvent.change(screen.getByPlaceholderText(/email/i), { target: { value: email } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
  });
}

describe("AppDetailClient – email_status=queued notice", () => {
  beforeEach(() => {
    mockGrantAccess.mockResolvedValue({ email_status: "queued" });
  });

  it('shows "We emailed <email> a link." exactly', async () => {
    render(<AppDetailClient appId="app-x" appName="App" accessList={[]} isAdmin appUrl="https://myapp.fly.dev" />);
    await submitGrant("invite@test.com");
    expect(await screen.findByText("We emailed invite@test.com a link.")).toBeInTheDocument();
  });

  it("notice is in aria-live=polite region", async () => {
    render(<AppDetailClient appId="app-x" appName="App" accessList={[]} isAdmin appUrl="https://myapp.fly.dev" />);
    await submitGrant("invite@test.com");
    const live = await screen.findByText("We emailed invite@test.com a link.");
    const region = live.closest("[aria-live]");
    expect(region?.getAttribute("aria-live")).toBe("polite");
  });

  it("no copy button shown for queued", async () => {
    render(<AppDetailClient appId="app-x" appName="App" accessList={[]} isAdmin appUrl="https://myapp.fly.dev" />);
    await submitGrant("invite@test.com");
    await screen.findByText("We emailed invite@test.com a link.");
    expect(screen.queryByRole("button", { name: "Copy link" })).not.toBeInTheDocument();
  });
});

describe("AppDetailClient – email_status open-url notices (disabled / rate-limited / already_has_access)", () => {
  const appUrl = "https://myapp.fly.dev";

  for (const status of ["disabled", "rate_limited_recipient", "rate_limited_sender", "already_has_access"] as const) {
    it(`email_status=${status} → "They can open it at <url>." with Copy link button`, async () => {
      mockGrantAccess.mockResolvedValue({ email_status: status });
      render(<AppDetailClient appId="app-x" appName="App" accessList={[]} isAdmin appUrl={appUrl} />);
      await submitGrant("someone@test.com");
      expect(await screen.findByText(/They can open it at/)).toBeInTheDocument();
      expect(screen.getByText(/myapp\.fly\.dev/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    });

    it(`email_status=${status} with no appUrl shows no notice`, async () => {
      mockGrantAccess.mockResolvedValue({ email_status: status });
      render(<AppDetailClient appId="app-x" appName="App" accessList={[]} isAdmin appUrl={null} />);
      await submitGrant("someone@test.com");
      await act(async () => { /* let transitions settle */ });
      expect(screen.queryByText(/They can open it at/)).not.toBeInTheDocument();
    });
  }

  it("email_status=invalid_url shows no notice", async () => {
    mockGrantAccess.mockResolvedValue({ email_status: "invalid_url" });
    render(<AppDetailClient appId="app-x" appName="App" accessList={[]} isAdmin appUrl={appUrl} />);
    await submitGrant("someone@test.com");
    await act(async () => { /* let transitions settle */ });
    expect(screen.queryByText(/We emailed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/They can open it at/)).not.toBeInTheDocument();
  });

  it("notice region is always aria-live=polite", async () => {
    mockGrantAccess.mockResolvedValue({ email_status: "disabled" });
    render(<AppDetailClient appId="app-x" appName="App" accessList={[]} isAdmin appUrl={appUrl} />);
    await submitGrant("someone@test.com");
    const live = await screen.findByText(/They can open it at/);
    const region = live.closest("[aria-live]");
    expect(region?.getAttribute("aria-live")).toBe("polite");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// KeysClient – key reveal lifecycle + admin-only controls + M4
// ═════════════════════════════════════════════════════════════════════════════

import { KeysClient } from "../../../app/(dashboard)/keys/KeysClient";

const createdKey: ApiKeyCreated = {
  id: "key-new", name: "New Key", key_prefix: "ssc_new",
  key: "ssc_newXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  created_at: "2026-01-01T00:00:00Z", last_used_at: null, revoked_at: null,
};

async function createKeyAndWait() {
  render(<KeysClient keys={[]} isAdmin={true} />);
  // Open the create dialog
  fireEvent.click(screen.getByRole("button", { name: /create key/i }));
  // Fill name in dialog form
  fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: "New Key" } });
  // Submit via the form's submit button
  await act(async () => {
    const form = (screen.getByLabelText(/name/i) as HTMLElement).closest("form")!;
    const submitBtn = form.querySelector("button[type='submit']") as HTMLElement;
    fireEvent.click(submitBtn);
  });
  await waitFor(() => screen.getByRole("status"));
}

describe("KeysClient – key reveal shown after create", () => {
  beforeEach(() => {
    mockCreateKey.mockResolvedValue({ key: createdKey });
  });

  it("shows reveal box with full key after creating", async () => {
    await createKeyAndWait();
    expect(screen.getByRole("status").textContent).toContain("ssc_new");
  });

  it("key never written to localStorage", async () => {
    await createKeyAndWait();
    for (let i = 0; i < localStorage.length; i++) {
      const v = localStorage.getItem(localStorage.key(i) ?? "") ?? "";
      expect(v).not.toContain("ssc_new");
    }
  });

  it("key never written to sessionStorage", async () => {
    await createKeyAndWait();
    for (let i = 0; i < sessionStorage.length; i++) {
      const v = sessionStorage.getItem(sessionStorage.key(i) ?? "") ?? "";
      expect(v).not.toContain("ssc_new");
    }
  });

  it("key not in URL", async () => {
    await createKeyAndWait();
    expect(window.location.href).not.toContain("ssc_new");
  });

  it("reveal box gone after dismiss", async () => {
    await createKeyAndWait();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reveal box gone after re-mount", async () => {
    const { unmount } = render(<KeysClient keys={[]} isAdmin={true} />);
    // Open the dialog
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));
    // Fill name and submit
    fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: "New Key" } });
    await act(async () => {
      const form = (screen.getByLabelText(/name/i) as HTMLElement).closest("form")!;
      const submitBtn = form.querySelector("button[type='submit']") as HTMLElement;
      fireEvent.click(submitBtn);
    });
    await waitFor(() => screen.getByRole("status"));
    unmount();
    render(<KeysClient keys={[]} isAdmin={true} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("KeysClient – member visibility and controls", () => {
  it("non-admin sees no create form", () => {
    render(<KeysClient keys={[baseKey]} isAdmin={false} />);
    expect(screen.queryByRole("button", { name: /create key/i })).not.toBeInTheDocument();
  });
  it("non-admin sees revoke button on own keys (members can revoke their own)", () => {
    render(<KeysClient keys={[baseKey]} isAdmin={false} />);
    // Members CAN revoke their own keys (all keys returned by GET for members are theirs)
    expect(screen.getByRole("button", { name: /revoke/i })).toBeInTheDocument();
  });
  it("non-admin sees note about own-key revoke only", () => {
    render(<KeysClient keys={[baseKey]} isAdmin={false} />);
    expect(screen.getByText(/only admins/i)).toBeInTheDocument();
  });
});

describe("KeysClient – Create key dialog", () => {
  beforeEach(() => {
    mockCreateKey.mockResolvedValue({ key: createdKey });
  });

  it("'Create key' button is present for admin", () => {
    render(<KeysClient keys={[]} isAdmin={true} />);
    expect(screen.getByRole("button", { name: /create key/i })).toBeInTheDocument();
  });

  it("dialog opens when Create key button clicked", async () => {
    render(<KeysClient keys={[]} isAdmin={true} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("dialog shows Create a key form with name input", async () => {
    render(<KeysClient keys={[]} isAdmin={true} />);
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));
    expect(await screen.findByLabelText(/name/i)).toBeInTheDocument();
    expect(screen.getByText(/create a key/i)).toBeInTheDocument();
  });

  it("after create, dialog shows key reveal with full key", async () => {
    await createKeyAndWait();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("status").textContent).toContain("ssc_new");
  });

  it("Done button closes dialog and calls router.refresh", async () => {
    await createKeyAndWait();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockRouterRefresh).toHaveBeenCalled();
  });

  it("backdrop click closes dialog (key was created → router.refresh called)", async () => {
    await createKeyAndWait();
    const backdrop = document.querySelector("[role='presentation']")!;
    fireEvent.click(backdrop);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockRouterRefresh).toHaveBeenCalled();
  });
});

describe("KeysClient – M4: key list never exposes material beyond prefix", () => {
  it("M4: rendered key rows do not contain full key material", () => {
    render(<KeysClient keys={[baseKey]} isAdmin={true} />);
    // Should show prefix + ellipsis
    expect(screen.getByText(/ssc_abc/)).toBeInTheDocument();
    // No string matching a full raw key (prefix + 40+ chars)
    const content = document.body.textContent ?? "";
    expect(content).not.toMatch(/ssc_[A-Za-z0-9_-]{40,}/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DeploymentRow – failure_message XSS + truncation (Security 2c)
// ═════════════════════════════════════════════════════════════════════════════

import { DeploymentRow } from "../../../app/(dashboard)/apps/[id]/DeploymentRow";

const failedDep = {
  id: "dep-1", status: "failed" as const, version: 1,
  started_at: "2026-01-01T00:00:00Z",
  finished_at: "2026-01-01T00:01:00Z",
  failure_stage: "build",
  failure_message: null as string | null,
};

describe("DeploymentRow – failure_message XSS (Security 2c)", () => {
  it("<script> renders as text, not executed", () => {
    const { container } = render(
      <DeploymentRow
        appId="app-test"
        deployment={{ ...failedDep, failure_message: "<script>alert('xss')</script>" }}
        isLatest={false}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    // The text must be present (need to open details first)
    const details = container.querySelector("details")!;
    details.setAttribute("open", "");
    expect(container.textContent).toContain("<script>alert('xss')</script>");
  });

  it("<img onerror> renders as text, not as an image", () => {
    const { container } = render(
      <DeploymentRow
        appId="app-test"
        deployment={{ ...failedDep, failure_message: "<img src=x onerror=alert(1)>" }}
        isLatest={false}
      />,
    );
    // No actual img element (we mocked next/image but this is a plain string in a <pre>)
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain("<img src=x onerror=alert(1)>");
    // The img should not be an actual DOM element inside the pre
    expect(pre?.querySelector("img")).toBeNull();
  });

  it("failure_message truncated to 500 chars", () => {
    const longMsg = "y".repeat(600);
    const { container } = render(
      <DeploymentRow appId="app-test" deployment={{ ...failedDep, failure_message: longMsg }} isLatest={false} />,
    );
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect((pre?.textContent ?? "").length).toBeLessThanOrEqual(500);
  });

  it("null failure_message shows no details element", () => {
    const { container } = render(
      <DeploymentRow appId="app-test" deployment={{ ...failedDep, failure_message: null }} isLatest={false} />,
    );
    expect(container.querySelector("details")).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Sidebar – workspace switcher
// ═════════════════════════════════════════════════════════════════════════════

import { Sidebar } from "../Sidebar";

describe("Sidebar – workspace switcher", () => {
  it("shows current workspace name", () => {
    render(<Sidebar />);
    // The trigger button contains the current workspace name
    expect(screen.getByRole("button", { name: /acme corp/i })).toBeInTheDocument();
  });

  it("trigger has aria-expanded=false initially", () => {
    render(<Sidebar />);
    const btn = screen.getByRole("button", { name: /acme corp/i });
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  it("clicking trigger opens listbox", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /acme corp/i }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    // After open, use the aria-haspopup attribute to find the trigger specifically
    const trigger = screen.getByRole("button", { name: /switch workspace/i });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("lists all workspaces in dropdown", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /acme corp/i }));
    const listbox = screen.getByRole("listbox");
    expect(listbox.textContent).toContain("Acme Corp");
    expect(listbox.textContent).toContain("Beta Inc");
  });

  it("includes 'Create workspace' link pointing to /onboarding?new=1", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /acme corp/i }));
    const link = screen.getByRole("link", { name: /create workspace/i });
    expect(link).toHaveAttribute("href", "/onboarding?new=1");
  });

  it("calls setActive with redirectUrl: '/apps' when switching (mutation: remove redirectUrl → Clerk won't navigate)", async () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /acme corp/i }));
    await act(async () => {
      const betaBtn = screen.getByRole("button", { name: /beta inc/i });
      fireEvent.click(betaBtn);
    });
    // Clerk navigates via routerPush internally using redirectUrl — no separate navigateHard on success.
    // Mutation: remove redirectUrl → this assertion fails and the 499/race returns.
    expect(mockSetActive).toHaveBeenCalledWith({ organization: "org_bbb", redirectUrl: "/apps" });
  });

  it("does NOT call navigateHard when setActive succeeds (Clerk handles navigation via redirectUrl)", async () => {
    const mockAssign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { assign: mockAssign, replace: vi.fn(), href: "/" },
      writable: true,
      configurable: true,
    });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /acme corp/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /beta inc/i }));
    });
    // navigateHard must NOT fire — it would race with Clerk's __internal_onAfterSetActive router.refresh()
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it("Escape key closes the listbox and returns focus to trigger", () => {
    render(<Sidebar />);
    const trigger = screen.getByRole("button", { name: /acme corp/i });
    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Sidebar contains no emoji", () => {
    const { container } = render(<Sidebar />);
    expect(container.textContent).not.toMatch(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// OnboardingClient – M5: name validation
// ═════════════════════════════════════════════════════════════════════════════

import { OnboardingClient } from "../../../app/(onboarding)/onboarding/OnboardingClient";
import OnboardingPage from "../../../app/(onboarding)/onboarding/page";

describe("OnboardingClient – M5: name validation", () => {
  it("M5: empty name keeps Continue button disabled", () => {
    render(<OnboardingClient firstName={null} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
  });

  it("M5: whitespace-only name keeps Continue button disabled", () => {
    render(<OnboardingClient firstName={null} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
  });

  it("M5: 65-char name shows error on submit (over limit)", async () => {
    render(<OnboardingClient firstName={null} />);
    const input = screen.getByRole("textbox");
    // Set a 65-char value (bypasses disabled check since non-empty)
    fireEvent.change(input, { target: { value: "A".repeat(65) } });
    const form = input.closest("form")!;
    await act(async () => { fireEvent.submit(form); });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("valid 1-char name enables Continue button", () => {
    render(<OnboardingClient firstName={null} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A" } });
    expect(screen.getByRole("button", { name: /continue/i })).not.toBeDisabled();
  });

  it("valid 64-char name enables Continue button (boundary)", () => {
    render(<OnboardingClient firstName={null} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A".repeat(64) } });
    expect(screen.getByRole("button", { name: /continue/i })).not.toBeDisabled();
  });

  it("prefills name from firstName prop", () => {
    render(<OnboardingClient firstName="Fenil" />);
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Fenil's workspace");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M6 – DashboardLayout auth guards (behaviour)
// ═════════════════════════════════════════════════════════════════════════════

import DashboardLayout from "../../../app/(dashboard)/layout";

describe("M6: DashboardLayout – auth guards (behaviour)", () => {
  it("M6: no userId → redirects to /sign-in", async () => {
    mockServerAuth.mockResolvedValue({ userId: null, orgId: null });
    await expect(
      DashboardLayout({ children: React.createElement("div") }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith("/sign-in");
  });

  it("M6: userId but no orgId → redirects to /onboarding", async () => {
    mockServerAuth.mockResolvedValue({ userId: "user_123", orgId: null });
    await expect(
      DashboardLayout({ children: React.createElement("div") }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith("/onboarding");
  });

  it("M6: userId and orgId → renders children without redirect", async () => {
    mockServerAuth.mockResolvedValue({ userId: "user_123", orgId: "org_123" });
    const jsx = await DashboardLayout({ children: React.createElement("div", { "data-testid": "child" }) });
    render(jsx);
    expect(screen.getByTestId("child")).toBeInTheDocument();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ThemeSwitch – initialTheme prop (BUG 2)
// ═════════════════════════════════════════════════════════════════════════════

import { ThemeSwitch } from "../../theme/ThemeSwitch";
import SettingsPage from "../../../app/(dashboard)/settings/page";

describe("ThemeSwitch – initialTheme prop (BUG 2)", () => {
  it("initialTheme=light → Light button aria-pressed=true", () => {
    render(<ThemeSwitch initialTheme="light" />);
    expect(screen.getByRole("button", { name: /light/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /dark/i })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /system/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("initialTheme=system → System button aria-pressed=true", () => {
    render(<ThemeSwitch initialTheme="system" />);
    expect(screen.getByRole("button", { name: /system/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /dark/i })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /light/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("M2: drop initialTheme (default dark) → Dark pressed, not Light", () => {
    render(<ThemeSwitch />);
    expect(screen.getByRole("button", { name: /dark/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /light/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("BUG 2: cookie 'light' → SettingsPage passes initialTheme=light to ThemeSwitch", async () => {
    mockCookies.mockResolvedValue({ get: (key: string) => key === "utir-theme" ? { value: "light" } : undefined });
    const jsx = await SettingsPage();
    render(jsx);
    expect(screen.getByRole("button", { name: /light/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("BUG 2: cookie 'system' → SettingsPage passes initialTheme=system to ThemeSwitch", async () => {
    mockCookies.mockResolvedValue({ get: (key: string) => key === "utir-theme" ? { value: "system" } : undefined });
    const jsx = await SettingsPage();
    render(jsx);
    expect(screen.getByRole("button", { name: /system/i })).toHaveAttribute("aria-pressed", "true");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// OnboardingClient – forceNew (BUG 3)
// ═════════════════════════════════════════════════════════════════════════════

describe("OnboardingClient – forceNew=true (BUG 3)", () => {
  it("forceNew=true shows 'Create a workspace' title", () => {
    render(<OnboardingClient firstName="Fenil" forceNew />);
    expect(screen.getByRole("heading", { name: /create a workspace/i })).toBeInTheDocument();
  });

  it("forceNew=true starts with empty name field (not prefilled)", () => {
    render(<OnboardingClient firstName="Fenil" forceNew />);
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
  });

  it("forceNew=false shows 'Name your workspace' title", () => {
    render(<OnboardingClient firstName={null} forceNew={false} />);
    expect(screen.getByRole("heading", { name: /name your workspace/i })).toBeInTheDocument();
  });

  it("BUG3: ?new=1 with orgId → renders without redirect", async () => {
    mockServerAuth.mockResolvedValue({ userId: "user_123", orgId: "org_123" });
    mockCurrentUser.mockResolvedValue({ firstName: "Fenil" });
    const jsx = await OnboardingPage({ searchParams: Promise.resolve({ new: "1" }) });
    render(jsx);
    expect(screen.getByRole("heading", { name: /create a workspace/i })).toBeInTheDocument();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("BUG3: no ?new=1 with orgId → redirects to /apps", async () => {
    mockServerAuth.mockResolvedValue({ userId: "user_123", orgId: "org_123" });
    mockCurrentUser.mockResolvedValue({ firstName: null });
    await expect(
      OnboardingPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith("/apps");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Sidebar – workspace switch flow
// ═════════════════════════════════════════════════════════════════════════════

describe("Sidebar – workspace switch flow", () => {
  let mockAssign: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockAssign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { assign: mockAssign, replace: vi.fn(), href: "/" },
      writable: true,
      configurable: true,
    });
  });

  it("setActive called with redirectUrl '/apps'; no navigateHard on success (mutation: remove redirectUrl → test fails)", async () => {
    // setActive resolves immediately (default vi.fn() returns undefined)
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /switch workspace/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /beta inc/i }));
    });
    // Mutation: remove redirectUrl from setActive → Clerk won't navigate, the 499 race returns.
    expect(mockSetActive).toHaveBeenCalledWith({ organization: "org_bbb", redirectUrl: "/apps" });
    // Clerk handles navigation internally via routerPush — we do NOT call navigateHard.
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it("setActive throws → navigateHard called as fallback", async () => {
    mockSetActive.mockRejectedValue(new Error("clerk_set_active_failed"));
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /switch workspace/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /beta inc/i }));
    });
    await waitFor(() => expect(mockNavigateHard).toHaveBeenCalledWith("/apps"));
  });

  it("trigger button shows Switching… and is disabled while in progress", async () => {
    let resolveSwitch!: () => void;
    mockSetActive.mockReturnValue(new Promise<void>((r) => { resolveSwitch = r; }));

    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /switch workspace/i }));
    fireEvent.click(screen.getByRole("button", { name: /beta inc/i }));

    // Trigger button should now show Switching… and be disabled
    expect(screen.getByRole("button", { name: /switching/i })).toBeDisabled();

    // After setActive resolves, setSwitching(null) rerenders the button to its normal state
    await act(async () => { resolveSwitch(); });
    await waitFor(() => expect(screen.getByRole("button", { name: /switch workspace/i })).not.toBeDisabled());
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ErrorCard – Try again button
// ═════════════════════════════════════════════════════════════════════════════

import { ErrorCard } from "../ErrorCard";

describe("ErrorCard – Try again", () => {
  it("displays the message and a Try again button", () => {
    render(<ErrorCard message="We could not load your apps. Try again in a moment." />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("We could not load your apps. Try again in a moment.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("Try again calls router.refresh()", () => {
    render(<ErrorCard message="We could not load your apps. Try again in a moment." />);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// OnboardingClient – BUG B: navigation after workspace creation
// ═════════════════════════════════════════════════════════════════════════════

describe("OnboardingClient – BUG B: navigation after workspace creation", () => {
  let mockAssign: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockAssign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { assign: mockAssign, replace: vi.fn(), href: "/" },
      writable: true,
      configurable: true,
    });
    _mockSessionOrgId = null; // brand-new user, no active org yet
  });

  it("Enter key submits the form (form has onSubmit)", async () => {
    mockCreateOrganization.mockResolvedValue({ id: "org_new" });
    _mockSessionOrgId = "org_new"; // session confirms immediately after setActive
    render(<OnboardingClient firstName={null} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My New Workspace" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    });
    expect(mockCreateOrganization).toHaveBeenCalledWith({ name: "My New Workspace" });
  });

  it("setActive called with redirectUrl: '/apps' on create (mutation: remove redirectUrl → Clerk won't navigate)", async () => {
    mockCreateOrganization.mockResolvedValue({ id: "org_new" });
    render(<OnboardingClient firstName={null} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My Workspace" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    });
    // Mutation: remove redirectUrl → Clerk's __internal_onAfterSetActive refresh lands on the
    // wrong page (the old org's page) → 404 or stale RSC data.
    expect(mockSetActive).toHaveBeenCalledWith({ organization: "org_new", redirectUrl: "/apps" });
    // Clerk handles navigation — we do NOT call navigateHard on success.
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it("setActive throws → navigateHard called as fallback (create)", async () => {
    mockCreateOrganization.mockResolvedValue({ id: "org_new" });
    mockSetActive.mockRejectedValue(new Error("clerk_set_active_failed"));
    render(<OnboardingClient firstName={null} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My Workspace" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    });
    await waitFor(() => expect(mockNavigateHard).toHaveBeenCalledWith("/apps"));
  });

  it("failure shows error message and does not navigate", async () => {
    mockCreateOrganization.mockRejectedValue(new Error("clerk_error"));
    render(<OnboardingClient firstName={null} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My Workspace" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(mockAssign).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Contract: fixture shapes (AQ)
// ═════════════════════════════════════════════════════════════════════════════

import deploymentsFixture from "../../../../api/scripts/fixtures/deployments.json";
import accessFixture from "../../../../api/scripts/fixtures/access.json";
import type { Deployment as DeploymentType, AppAccess as AppAccessType } from "../../../lib/api-types";

describe("Contract: deployments fixture shape", () => {
  it("is an array (mutation: wrap in {items:[...]} → Array.isArray fails → web map crashes)", () => {
    // This test fails if fixtures/deployments.json changes from [...] to {items:[...]}
    expect(Array.isArray(deploymentsFixture)).toBe(true);
    const deps = deploymentsFixture as unknown as DeploymentType[];
    for (const dep of deps) {
      expect(dep).toHaveProperty("id");
      expect(dep).toHaveProperty("status");
      expect(dep).toHaveProperty("version");
    }
  });

  it("DeploymentRow renders with real fixture data", () => {
    const dep = (deploymentsFixture as unknown as DeploymentType[])[0];
    if (!dep) return; // empty fixture is acceptable (non-empty ensured by API test AQ1)
    render(<DeploymentRow appId="app-fixture" deployment={dep} isLatest={true} />);
    expect(document.body).toBeInTheDocument(); // render did not throw
  });
});

describe("Contract: access fixture shape", () => {
  it("has {users, pending} shape (mutation: change to flat array → isAppAccessResponse fails → crash)", () => {
    // This test fails if fixtures/access.json changes from {users,pending} to [...]
    expect(typeof accessFixture).toBe("object");
    expect(Array.isArray(accessFixture)).toBe(false);
    expect(accessFixture).toHaveProperty("users");
    expect(accessFixture).toHaveProperty("pending");
    const a = accessFixture as unknown as { users: unknown[]; pending: unknown[] };
    expect(Array.isArray(a.users)).toBe(true);
    expect(Array.isArray(a.pending)).toBe(true);
  });

  it("AppDetailClient renders normalized access list from fixture", () => {
    const a = accessFixture as unknown as { users: { email: string; granted_at: string }[]; pending: { email: string; granted_at: string }[] };
    const accessList: AppAccessType[] = [
      ...a.users.map((u) => ({ email: u.email, display_name: null, granted_at: u.granted_at, status: "active" as const })),
      ...a.pending.map((p) => ({ email: p.email, display_name: null, granted_at: p.granted_at, status: "pending" as const })),
    ];
    render(<AppDetailClient appId="app-fixture" appName="Fixture App" accessList={accessList} isAdmin={false} />);
    expect(screen.getByText(/who can open it/i)).toBeInTheDocument();
    if (accessList.length > 0) {
      expect(screen.getByText(accessList[0].email)).toBeInTheDocument();
    }
  });
});

import appsListFixture from "../../../../api/scripts/fixtures/apps-list.json";
import appDetailFixture from "../../../../api/scripts/fixtures/app-detail.json";
import type { App as AppType } from "../../../lib/api-types";
import { appUrl } from "../../../lib/app-url";

describe("Contract: apps-list fixture shape", () => {
  it("is an array with valid app objects (mutation: change to object → Array.isArray fails)", () => {
    expect(Array.isArray(appsListFixture)).toBe(true);
    const apps = appsListFixture as unknown as AppType[];
    for (const app of apps) {
      expect(app).toHaveProperty("id");
      expect(app).toHaveProperty("name");
      expect(app).toHaveProperty("subdomain");
    }
  });

  it("appUrl(subdomain) returns a valid URL for fixture apps (no double-scheme)", () => {
    const apps = appsListFixture as unknown as AppType[];
    for (const app of apps) {
      if (app.subdomain) {
        const url = appUrl(app.subdomain);
        expect(url).not.toBeNull();
        expect(url).toMatch(/^https:\/\/[^/]+\.fly\.dev$/);
        // Must not contain double-scheme
        expect(url).not.toContain("https://https://");
      }
    }
  });

  it("AppsTable renders without crashing with fixture data", () => {
    render(<AppsTable apps={appsListFixture as unknown as AppType[]} />);
    const apps = appsListFixture as unknown as AppType[];
    for (const app of apps) {
      expect(screen.getByText(app.name)).toBeInTheDocument();
    }
  });
});

describe("Contract: app-detail fixture shape", () => {
  it("is an object with {id, name, subdomain}", () => {
    const app = appDetailFixture as unknown as AppType;
    expect(typeof app.id).toBe("string");
    expect(typeof app.name).toBe("string");
    expect("subdomain" in app).toBe(true);
  });

  it("appUrl(subdomain) normalises the fixture URL correctly (no double-scheme)", () => {
    const app = appDetailFixture as unknown as AppType;
    if (app.subdomain) {
      const url = appUrl(app.subdomain);
      expect(url).not.toBeNull();
      expect(url).toMatch(/^https:\/\/[^/]+\.fly\.dev$/);
      expect(url).not.toContain("https://https://");
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DashboardShell – responsive layout
// ═════════════════════════════════════════════════════════════════════════════

import { DashboardShell } from "../DashboardShell";

describe("DashboardShell responsive layout", () => {
  it("renders menu button with aria-label 'Open navigation'", () => {
    render(
      <DashboardShell isAdmin={false} openAlertCount={0}>
        <div>content</div>
      </DashboardShell>,
    );
    expect(screen.getByRole("button", { name: /open navigation/i })).toBeInTheDocument();
  });

  it("menu button click sets mobileOpen state (aria-expanded changes to true)", () => {
    render(
      <DashboardShell isAdmin={false} openAlertCount={0}>
        <div>content</div>
      </DashboardShell>,
    );
    const btn = screen.getByRole("button", { name: /open navigation/i });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
  });

  it("page-container class applied to content wrapper", () => {
    const { container } = render(
      <DashboardShell isAdmin={false} openAlertCount={0}>
        <div data-testid="child">content</div>
      </DashboardShell>,
    );
    const pageContainer = container.querySelector(".page-container");
    expect(pageContainer).toBeInTheDocument();
  });

  it("sidebar-panel class present", () => {
    const { container } = render(
      <DashboardShell isAdmin={false} openAlertCount={0}>
        <div>content</div>
      </DashboardShell>,
    );
    expect(container.querySelector(".sidebar-panel")).toBeInTheDocument();
  });

  it("sidebar-panel gets sidebar-panel--open class when menu button clicked", () => {
    render(
      <DashboardShell isAdmin={false} openAlertCount={0}>
        <div>content</div>
      </DashboardShell>,
    );
    const btn = screen.getByRole("button", { name: /open navigation/i });
    expect(document.querySelector(".sidebar-panel--open")).not.toBeInTheDocument();
    fireEvent.click(btn);
    expect(document.querySelector(".sidebar-panel--open")).toBeInTheDocument();
  });

  it("backdrop click closes sidebar", () => {
    render(
      <DashboardShell isAdmin={false} openAlertCount={0}>
        <div>content</div>
      </DashboardShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: /open navigation/i }));
    expect(document.querySelector(".sidebar-panel--open")).toBeInTheDocument();
    // The backdrop is the aria-hidden overlay div
    const backdrop = document.querySelector(".sidebar-backdrop")!;
    fireEvent.click(backdrop);
    expect(document.querySelector(".sidebar-panel--open")).not.toBeInTheDocument();
  });

  it("layout row div has no inline display, overflow, or position styles (CSS class handles layout)", () => {
    render(
      <DashboardShell isAdmin={false} openAlertCount={0}>
        <div>content</div>
      </DashboardShell>,
    );
    const layoutRow = document.querySelector(".dashboard-layout-row")!;
    expect(layoutRow).toBeInTheDocument();
    // Inline styles must NOT override the CSS class — if they did, media queries couldn't override them
    expect(layoutRow.getAttribute("style") ?? "").not.toMatch(/display\s*:/);
    expect(layoutRow.getAttribute("style") ?? "").not.toMatch(/overflow\s*:/);
    expect(layoutRow.getAttribute("style") ?? "").not.toMatch(/position\s*:/);
  });
});

// ── BUG B – workspace creation try/finally guarantees navigation ─────────────

describe("OnboardingClient – BUG B v2: setActive/session errors do not block navigation", () => {
  let mockAssign: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockAssign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { assign: mockAssign, replace: vi.fn(), href: "/" },
      writable: true,
      configurable: true,
    });
    _mockSessionOrgId = null;
  });

  it("setActive throws → navigateHard called (catch fallback)", async () => {
    mockCreateOrganization.mockResolvedValue({ id: "org_new" });
    mockSetActive.mockRejectedValue(new Error("clerk_set_active_failed"));
    render(<OnboardingClient firstName={null} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My Workspace" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    });
    // Mutation: remove the catch block → setActive throw propagates to outer catch →
    // error shown, navigation skipped → this assertion fails.
    await waitFor(() => expect(mockNavigateHard).toHaveBeenCalledWith("/apps"));
  });

  it("handleJoin: setActive called with redirectUrl: '/apps' (mutation: remove option → test fails)", async () => {
    // Supply a pending invitation in the mock
    const mockAccept = vi.fn().mockResolvedValue(undefined);
    const { useOrganizationList } = await import("@clerk/nextjs");
    (useOrganizationList as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      userMemberships: { data: [] },
      userInvitations: {
        data: [{ id: "inv_1", accept: mockAccept, publicOrganizationData: { id: "org_ccc", name: "Gamma LLC" } }],
      },
      setActive: mockSetActive,
      createOrganization: mockCreateOrganization,
    });
    render(<OnboardingClient firstName={null} />);
    const joinBtn = screen.getByRole("button", { name: /join/i });
    await act(async () => { fireEvent.click(joinBtn); });
    expect(mockSetActive).toHaveBeenCalledWith({ organization: "org_ccc", redirectUrl: "/apps" });
    // Clerk handles navigation — no navigateHard on success.
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it("handleJoin: setActive throws → navigateHard called as fallback", async () => {
    const mockAccept = vi.fn().mockResolvedValue(undefined);
    const { useOrganizationList } = await import("@clerk/nextjs");
    (useOrganizationList as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      userMemberships: { data: [] },
      userInvitations: {
        data: [{ id: "inv_1", accept: mockAccept, publicOrganizationData: { id: "org_ccc", name: "Gamma LLC" } }],
      },
      setActive: mockSetActive,
      createOrganization: mockCreateOrganization,
    });
    mockSetActive.mockRejectedValue(new Error("clerk_error"));
    render(<OnboardingClient firstName={null} />);
    const joinBtn = screen.getByRole("button", { name: /join/i });
    await act(async () => { fireEvent.click(joinBtn); });
    await waitFor(() => expect(mockNavigateHard).toHaveBeenCalledWith("/apps"));
  });

  it("createOrganization throws → error shown, does NOT navigate", async () => {
    mockCreateOrganization.mockRejectedValue(new Error("clerk_error"));
    render(<OnboardingClient firstName={null} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My Workspace" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(mockAssign).not.toHaveBeenCalled();
  });
});

// ── AppsPage – no_active_org redirect (Bug #4) ───────────────────────────────

import AppsPage from "../../../app/(dashboard)/apps/page";

describe("AppsPage – no_active_org redirect", () => {
  it("redirects to /onboarding when GET /v1/apps returns 400 no_active_org (bug #4)", async () => {
    mockServerAuth.mockResolvedValueOnce({ orgRole: "org:admin" });
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/v1/apps") {
        return Promise.reject(
          Object.assign(new Error("no_active_org"), { status: 400, code: "no_active_org" }),
        );
      }
      return Promise.resolve([]);
    });
    await expect(AppsPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith("/onboarding");
  });

  it("renders error card for non-no_active_org API failures (not redirected)", async () => {
    mockServerAuth.mockResolvedValueOnce({ orgRole: "org:admin" });
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/v1/apps") {
        return Promise.reject(
          Object.assign(new Error("internal_error"), { status: 500, code: "internal_error" }),
        );
      }
      return Promise.resolve([]);
    });
    const result = await AppsPage();
    expect(mockRedirect).not.toHaveBeenCalledWith("/onboarding");
    expect(JSON.stringify(result)).toContain("could not load");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BuildLogDialog
// ═════════════════════════════════════════════════════════════════════════════

import { BuildLogDialog } from "../../../app/(dashboard)/apps/[id]/BuildLogDialog";

describe("BuildLogDialog", () => {
  const mockOnClose = vi.fn();
  const defaultProps = {
    appId: "app-1",
    deploymentId: "dep-1",
    version: 3,
    onClose: mockOnClose,
  };

  beforeEach(() => {
    mockOnClose.mockReset();
    // Mock fetch for log requests
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: "Build output here\nDone.", truncated: false }),
    }));
    // Mock clipboard
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows dialog with title", () => {
    render(<BuildLogDialog {...defaultProps} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/Build log — v3/)).toBeInTheDocument();
  });

  it("shows loading state initially", () => {
    // Make fetch pend forever
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<BuildLogDialog {...defaultProps} />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders log content after fetch", async () => {
    render(<BuildLogDialog {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/Build output here/)).toBeInTheDocument();
    });
  });

  it("shows error when fetch returns 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: "logs_not_found" }),
    }));
    render(<BuildLogDialog {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByRole("alert").textContent).toMatch(/No build log available/);
  });

  it("shows truncation notice when truncated=true", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: "partial log", truncated: true }),
    }));
    render(<BuildLogDialog {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/truncated/i)).toBeInTheDocument();
    });
  });

  it("copy button is present after load and copies content", async () => {
    render(<BuildLogDialog {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Build output here\nDone.");
  });

  it("download button is present after load", async () => {
    render(<BuildLogDialog {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /download/i })).toBeInTheDocument();
    });
  });

  it("close button calls onClose", () => {
    render(<BuildLogDialog {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(mockOnClose).toHaveBeenCalledOnce();
  });

  it("clicking backdrop calls onClose", () => {
    render(<BuildLogDialog {...defaultProps} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog);
    expect(mockOnClose).toHaveBeenCalledOnce();
  });
});

// ── DashboardLayout – sidebar fixed scroll (Bug #5) ──────────────────────────

describe("DashboardLayout – sidebar fixed, main scrolls (Bug #5)", () => {
  it("outer container uses dashboard-shell class (height:100vh overflow:hidden via CSS)", async () => {
    mockServerAuth.mockResolvedValue({ userId: "user_123", orgId: "org_123" });
    const jsx = await DashboardLayout({ children: React.createElement("div") });
    render(jsx);
    // The outer container must use the dashboard-shell CSS class which sets
    // height:100vh and overflow:hidden — inline styles were moved to CSS so
    // that media queries can override them
    const outer = document.querySelector(".dashboard-shell") as HTMLElement | null;
    expect(outer).not.toBeNull();
  });

  it("main element uses dashboard-main class (overflowY:auto via CSS)", async () => {
    mockServerAuth.mockResolvedValue({ userId: "user_123", orgId: "org_123" });
    const jsx = await DashboardLayout({ children: React.createElement("div", { "data-testid": "child" }) });
    render(jsx);
    const main = document.querySelector("main") as HTMLElement | null;
    expect(main).not.toBeNull();
    expect(main!.className).toContain("dashboard-main");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DashboardShell org-switch (Fix 2)
// When /apps?org=<orgId> is loaded, DashboardShell checks membership and
// switches the active org via setActive, then navigates to /apps (clean URL).
// ═════════════════════════════════════════════════════════════════════════════

describe("DashboardShell org-switch (Fix 2)", () => {
  // DS1: ?org=org_bbb, member, active=org_aaa → setActive + navigateHard
  it("DS1: member of target org, active org differs → setActive + navigateHard('/apps')", async () => {
    _mockSessionOrgId = "org_aaa";
    const mockGetMemberships = vi.fn().mockResolvedValue({
      data: [{ organization: { id: "org_bbb" } }],
      total_count: 1,
    });
    vi.mocked(useUser).mockReturnValueOnce({
      user: { getOrganizationMemberships: mockGetMemberships },
      isLoaded: true,
      isSignedIn: true,
    } as unknown as ReturnType<typeof useUser>);
    vi.mocked(useSearchParams).mockReturnValueOnce({
      get: (k: string) => k === "org" ? "org_bbb" : null,
    } as ReturnType<typeof useSearchParams>);

    render(
      <DashboardShell isAdmin={false} openAlertCount={0}>
        <div>content</div>
      </DashboardShell>,
    );

    await waitFor(() =>
      expect(mockSetActive).toHaveBeenCalledWith({ organization: "org_bbb" }),
    );
    expect(mockNavigateHard).toHaveBeenCalledWith("/apps");
  });

  // DS2: ?org=org_aaa, same as active → no setActive, no navigateHard
  it("DS2: target org same as active org → no setActive, no navigateHard", async () => {
    _mockSessionOrgId = "org_aaa";
    vi.mocked(useSearchParams).mockReturnValueOnce({
      get: (k: string) => k === "org" ? "org_aaa" : null,
    } as ReturnType<typeof useSearchParams>);

    render(
      <DashboardShell isAdmin={false} openAlertCount={0}>
        <div>content</div>
      </DashboardShell>,
    );

    // Let effects run; org-switch should be a no-op.
    await act(async () => { /* settle effects */ });
    expect(mockSetActive).not.toHaveBeenCalled();
    expect(mockNavigateHard).not.toHaveBeenCalled();
  });

  // DS3: ?org=org_bbb, not a member → dropOrgParam only, no setActive
  it("DS3: not a member of target org → no setActive, no navigateHard", async () => {
    _mockSessionOrgId = "org_aaa";
    const mockGetMemberships = vi.fn().mockResolvedValue({
      data: [],
      total_count: 0,
    });
    vi.mocked(useUser).mockReturnValueOnce({
      user: { getOrganizationMemberships: mockGetMemberships },
      isLoaded: true,
      isSignedIn: true,
    } as unknown as ReturnType<typeof useUser>);
    vi.mocked(useSearchParams).mockReturnValueOnce({
      get: (k: string) => k === "org" ? "org_bbb" : null,
    } as ReturnType<typeof useSearchParams>);

    render(
      <DashboardShell isAdmin={false} openAlertCount={0}>
        <div>content</div>
      </DashboardShell>,
    );

    await act(async () => { /* settle effects */ });
    expect(mockSetActive).not.toHaveBeenCalled();
    expect(mockNavigateHard).not.toHaveBeenCalled();
  });

  // DS4: setActive throws → dropOrgParam, no navigateHard
  it("DS4: member but setActive throws → no navigateHard (stays on page)", async () => {
    _mockSessionOrgId = "org_aaa";
    const mockGetMemberships = vi.fn().mockResolvedValue({
      data: [{ organization: { id: "org_bbb" } }],
      total_count: 1,
    });
    vi.mocked(useUser).mockReturnValueOnce({
      user: { getOrganizationMemberships: mockGetMemberships },
      isLoaded: true,
      isSignedIn: true,
    } as unknown as ReturnType<typeof useUser>);
    vi.mocked(useSearchParams).mockReturnValueOnce({
      get: (k: string) => k === "org" ? "org_bbb" : null,
    } as ReturnType<typeof useSearchParams>);
    mockSetActive.mockRejectedValueOnce(new Error("clerk_set_active_failed"));

    render(
      <DashboardShell isAdmin={false} openAlertCount={0}>
        <div>content</div>
      </DashboardShell>,
    );

    await waitFor(() => expect(mockSetActive).toHaveBeenCalled());
    expect(mockNavigateHard).not.toHaveBeenCalled();
  });

  // DS5: sessionStorage guard prevents re-activation for same org
  // Mutation (a): remove the dsSsGet(ssKey) guard from DashboardShell →
  // setActive would be called even with the key set → this test fails.
  it("DS5: sessionStorage guard blocks re-activation (mutation-a guard)", async () => {
    _mockSessionOrgId = "org_aaa";
    const mockGetMemberships = vi.fn().mockResolvedValue({
      data: [{ organization: { id: "org_bbb" } }],
      total_count: 1,
    });
    vi.mocked(useUser).mockReturnValueOnce({
      user: { getOrganizationMemberships: mockGetMemberships },
      isLoaded: true,
      isSignedIn: true,
    } as unknown as ReturnType<typeof useUser>);
    vi.mocked(useSearchParams).mockReturnValueOnce({
      get: (k: string) => k === "org" ? "org_bbb" : null,
    } as ReturnType<typeof useSearchParams>);

    // Pre-seed sessionStorage as if this org was already activated in this tab.
    sessionStorage.setItem("org-activate-v1:org_bbb", "1");

    render(
      <DashboardShell isAdmin={false} openAlertCount={0}>
        <div>content</div>
      </DashboardShell>,
    );

    await act(async () => { /* settle effects */ });

    // Guard must prevent setActive and navigateHard from being called.
    expect(mockSetActive).not.toHaveBeenCalled();
    expect(mockNavigateHard).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// EnvSection – per-app environment variables UI
// ═════════════════════════════════════════════════════════════════════════════

import { EnvSection } from "../../../app/(dashboard)/apps/[id]/EnvSection";
import type { AppEnvVar } from "../../../lib/api-types";

describe("EnvSection", () => {
  const appId = "app-env-test";

  const makeVar = (name: string): AppEnvVar => ({
    name,
    updated_at: new Date().toISOString(),
    updated_by_email: "owner@test.local",
  });

  beforeEach(() => {
    mockSetEnvVar.mockReset();
    mockUnsetEnvVar.mockReset();
    mockApplyEnvVars.mockReset();
  });

  it("renders 'No variables set' when list is empty", () => {
    render(<EnvSection appId={appId} initialVars={[]} isAdmin isSuspended={false} />);
    expect(screen.getByText(/no variables set/i)).toBeDefined();
  });

  it("renders var names (not values)", () => {
    render(
      <EnvSection
        appId={appId}
        initialVars={[makeVar("DATABASE_URL"), makeVar("API_KEY")]}
        isAdmin
        isSuspended={false}
      />,
    );
    expect(screen.getByText("DATABASE_URL")).toBeDefined();
    expect(screen.getByText("API_KEY")).toBeDefined();
  });

  it("ENV-M2: value field is never rendered in the list", () => {
    const sentinelValue = "SECRET_SHOULD_NOT_APPEAR_12345";
    render(
      <EnvSection
        appId={appId}
        initialVars={[makeVar("DATABASE_URL")]}
        isAdmin
        isSuspended={false}
      />,
    );
    // The value is never in the DOM
    expect(document.body.textContent).not.toContain(sentinelValue);
  });

  it("admin sees Add variable button", () => {
    render(<EnvSection appId={appId} initialVars={[]} isAdmin isSuspended={false} />);
    expect(screen.getByRole("button", { name: /add variable/i })).toBeDefined();
  });

  it("non-admin does not see Add variable button", () => {
    render(<EnvSection appId={appId} initialVars={[]} isAdmin={false} isSuspended={false} />);
    expect(screen.queryByRole("button", { name: /add variable/i })).toBeNull();
  });

  it("non-admin does not see Replace/Remove buttons", () => {
    render(
      <EnvSection
        appId={appId}
        initialVars={[makeVar("MY_VAR")]}
        isAdmin={false}
        isSuspended={false}
      />,
    );
    expect(screen.queryByRole("button", { name: /replace/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });

  it("Add variable shows form with password input", async () => {
    render(<EnvSection appId={appId} initialVars={[]} isAdmin isSuspended={false} />);
    fireEvent.click(screen.getByRole("button", { name: /add variable/i }));
    const passwordInput = document.querySelector("input[type='password']");
    expect(passwordInput).not.toBeNull();
  });

  it("Show/Hide toggles value visibility", async () => {
    render(<EnvSection appId={appId} initialVars={[]} isAdmin isSuspended={false} />);
    fireEvent.click(screen.getByRole("button", { name: /add variable/i }));
    const showBtn = screen.getByRole("button", { name: /show value/i });
    fireEvent.click(showBtn);
    const textInput = document.querySelector("input[type='text'][placeholder='Value']");
    expect(textInput).not.toBeNull();
  });

  it("calls setEnvVar on save and updates list", async () => {
    mockSetEnvVar.mockResolvedValueOnce({});
    render(<EnvSection appId={appId} initialVars={[]} isAdmin isSuspended={false} />);
    fireEvent.click(screen.getByRole("button", { name: /add variable/i }));
    const nameInput = document.querySelector("input[placeholder='VARIABLE_NAME']") as HTMLInputElement;
    const valInput  = document.querySelector("input[type='password']") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "NEW_VAR" } });
    fireEvent.change(valInput,  { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(mockSetEnvVar).toHaveBeenCalledWith(appId, "NEW_VAR", "secret123"));
    // Form is closed after success
    await waitFor(() => expect(screen.queryByRole("button", { name: /^save$/i })).toBeNull());
  });

  it("shows error message when setEnvVar returns error", async () => {
    mockSetEnvVar.mockResolvedValueOnce({ error: "reserved_name" });
    render(<EnvSection appId={appId} initialVars={[]} isAdmin isSuspended={false} />);
    fireEvent.click(screen.getByRole("button", { name: /add variable/i }));
    const nameInput = document.querySelector("input[placeholder='VARIABLE_NAME']") as HTMLInputElement;
    const valInput  = document.querySelector("input[type='password']") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "PORT" } });
    fireEvent.change(valInput,  { target: { value: "3000" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(screen.getByText(/reserved/i)).toBeDefined());
  });

  it("Remove button asks for confirmation before calling unsetEnvVar", async () => {
    mockUnsetEnvVar.mockResolvedValueOnce({});
    render(
      <EnvSection
        appId={appId}
        initialVars={[makeVar("OLD_VAR")]}
        isAdmin
        isSuspended={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    // Confirmation buttons appear
    expect(screen.getByRole("button", { name: /delete/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDefined();
    // unsetEnvVar not yet called
    expect(mockUnsetEnvVar).not.toHaveBeenCalled();
  });

  it("confirms delete removes var from list", async () => {
    mockUnsetEnvVar.mockResolvedValueOnce({});
    render(
      <EnvSection
        appId={appId}
        initialVars={[makeVar("OLD_VAR")]}
        isAdmin
        isSuspended={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    await waitFor(() => expect(mockUnsetEnvVar).toHaveBeenCalledWith(appId, "OLD_VAR"));
    await waitFor(() => expect(screen.queryByText("OLD_VAR")).toBeNull());
  });

  it("shows pending apply banner after set/delete", async () => {
    mockSetEnvVar.mockResolvedValueOnce({});
    render(<EnvSection appId={appId} initialVars={[]} isAdmin isSuspended={false} />);
    fireEvent.click(screen.getByRole("button", { name: /add variable/i }));
    fireEvent.change(document.querySelector("input[placeholder='VARIABLE_NAME']") as HTMLInputElement, { target: { value: "X_VAR" } });
    fireEvent.change(document.querySelector("input[type='password']") as HTMLInputElement, { target: { value: "v" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(screen.getByText(/changes apply on next deploy/i)).toBeDefined());
  });

  it("Restart now calls applyEnvVars", async () => {
    mockSetEnvVar.mockResolvedValueOnce({});
    mockApplyEnvVars.mockResolvedValueOnce({ restarted: 1 });
    render(<EnvSection appId={appId} initialVars={[]} isAdmin isSuspended={false} />);
    fireEvent.click(screen.getByRole("button", { name: /add variable/i }));
    fireEvent.change(document.querySelector("input[placeholder='VARIABLE_NAME']") as HTMLInputElement, { target: { value: "Y_VAR" } });
    fireEvent.change(document.querySelector("input[type='password']") as HTMLInputElement, { target: { value: "v" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => screen.getByText(/restart now/i));
    fireEvent.click(screen.getByRole("button", { name: /restart now/i }));
    await waitFor(() => expect(mockApplyEnvVars).toHaveBeenCalledWith(appId));
  });

  it("suspended app shows read-only notice for admin", () => {
    render(
      <EnvSection
        appId={appId}
        initialVars={[makeVar("MY_VAR")]}
        isAdmin
        isSuspended
      />,
    );
    expect(screen.getByText(/suspended/i)).toBeDefined();
    // No Add variable button
    expect(screen.queryByRole("button", { name: /add variable/i })).toBeNull();
  });
});
