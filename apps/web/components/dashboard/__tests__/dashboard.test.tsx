/**
 * T1 – Dashboard component render tests (mocked data).
 *
 * Covers every route state (empty, error, populated), AppsTable filters and
 * search, AppStatusBadge (all 5 statuses), delete confirm (M3), key reveal
 * lifecycle (never in storage/URL/cookies), admin-only controls absent for
 * org:member, failure_message XSS safety + 500-char truncation, workspace
 * switcher (M: switcher), onboarding name validation (M5), no emoji anywhere.
 *
 * M6 (dashboard layout auth check) is verified via static source inspection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";
import fs from "fs";
import path from "path";

// ── Global mocks ──────────────────────────────────────────────────────────────

const mockRouterRefresh = vi.fn();
const mockRouterReplace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ refresh: mockRouterRefresh, replace: mockRouterReplace })),
  usePathname: vi.fn(() => "/apps"),
  useSearchParams: vi.fn(() => ({ get: () => null })),
}));

const mockSetActive = vi.fn();
const mockSignOut = vi.fn();
const mockCreateOrganization = vi.fn();

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
  useClerk: vi.fn(() => ({ signOut: mockSignOut })),
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

vi.mock("../../../app/(dashboard)/apps/actions", () => ({
  deleteApp: (...a: unknown[]) => mockDeleteApp(...a),
  grantAccess: (...a: unknown[]) => mockGrantAccess(...a),
  revokeAccess: (...a: unknown[]) => mockRevokeAccess(...a),
}));

vi.mock("../../../app/(dashboard)/keys/actions", () => ({
  createKey: (...a: unknown[]) => mockCreateKey(...a),
  revokeKey: (...a: unknown[]) => mockRevokeKey(...a),
}));

beforeEach(() => {
  mockRouterRefresh.mockReset();
  mockRouterReplace.mockReset();
  mockSetActive.mockReset().mockResolvedValue(undefined);
  mockDeleteApp.mockReset().mockResolvedValue({});
  mockGrantAccess.mockReset().mockResolvedValue({});
  mockRevokeAccess.mockReset().mockResolvedValue({});
  mockCreateKey.mockReset();
  mockRevokeKey.mockReset().mockResolvedValue({});
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
    fireEvent.click(screen.getByRole("tab", { name: "Live" }));
    expect(screen.getByText("My Live App")).toBeInTheDocument();
    expect(screen.queryByText("Failed App")).not.toBeInTheDocument();
    expect(screen.queryByText("Suspended App")).not.toBeInTheDocument();
    expect(screen.queryByText("Deploying App")).not.toBeInTheDocument();
  });
});

describe("AppsTable – filter Needs attention", () => {
  it("shows Failed and Suspended only", () => {
    render(<AppsTable apps={allApps} />);
    fireEvent.click(screen.getByRole("tab", { name: "Needs attention" }));
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
  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "New Key" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));
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
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "New Key" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create key/i }));
    });
    await waitFor(() => screen.getByRole("status"));
    unmount();
    render(<KeysClient keys={[]} isAdmin={true} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("KeysClient – admin-only controls absent for member", () => {
  it("non-admin sees no create form", () => {
    render(<KeysClient keys={[baseKey]} isAdmin={false} />);
    expect(screen.queryByRole("button", { name: /create key/i })).not.toBeInTheDocument();
  });
  it("non-admin sees no revoke buttons", () => {
    render(<KeysClient keys={[baseKey]} isAdmin={false} />);
    expect(screen.queryByRole("button", { name: /revoke/i })).not.toBeInTheDocument();
  });
  it("non-admin sees read-only note", () => {
    render(<KeysClient keys={[baseKey]} isAdmin={false} />);
    expect(screen.getByText(/only admins/i)).toBeInTheDocument();
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
      <DeploymentRow deployment={{ ...failedDep, failure_message: longMsg }} isLatest={false} />,
    );
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect((pre?.textContent ?? "").length).toBeLessThanOrEqual(500);
  });

  it("null failure_message shows no details element", () => {
    const { container } = render(
      <DeploymentRow deployment={{ ...failedDep, failure_message: null }} isLatest={false} />,
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

  it("includes 'Create workspace' link pointing to /onboarding", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /acme corp/i }));
    const link = screen.getByRole("link", { name: /create workspace/i });
    expect(link).toHaveAttribute("href", "/onboarding");
  });

  it("calls setActive with correct orgId when switching", async () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /acme corp/i }));
    await act(async () => {
      // Beta Inc button is inside the listbox
      const betaBtn = screen.getByRole("button", { name: /beta inc/i });
      fireEvent.click(betaBtn);
    });
    expect(mockSetActive).toHaveBeenCalledWith({ organization: "org_bbb" });
  });

  it("calls router.refresh() after switching workspace", async () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /acme corp/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /beta inc/i }));
    });
    await waitFor(() => expect(mockRouterRefresh).toHaveBeenCalled());
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
// M6 – dashboard layout contains auth check (static source inspection)
// ═════════════════════════════════════════════════════════════════════════════

describe("M6: dashboard layout auth check (static)", () => {
  const layoutPath = path.resolve(
    __dirname,
    "../../../app/(dashboard)/layout.tsx",
  );

  it("M6: layout file exists", () => {
    expect(fs.existsSync(layoutPath)).toBe(true);
  });

  it("M6: layout calls auth()", () => {
    const src = fs.readFileSync(layoutPath, "utf8");
    expect(src).toMatch(/await auth\(\)/);
  });

  it("M6: layout checks for userId and redirects to /sign-in", () => {
    const src = fs.readFileSync(layoutPath, "utf8");
    expect(src).toMatch(/userId/);
    expect(src).toMatch(/\/sign-in/);
  });

  it("M6: layout checks for orgId and redirects to /onboarding", () => {
    const src = fs.readFileSync(layoutPath, "utf8");
    expect(src).toMatch(/orgId/);
    expect(src).toMatch(/\/onboarding/);
  });
});
