/**
 * Settings page — WorkspaceDeleteSection tests
 *
 * M1 kill: "submit button disabled until name matches" — canDelete guard must gate on name equality
 * M2 kill: "danger zone hidden for non-admins" — settings page must not render WorkspaceDeleteSection when isAdmin=false
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

// ── Mock Clerk client hooks ───────────────────────────────────────────────────

const mockSetActive = vi.fn();

vi.mock("@clerk/nextjs", () => ({
  useClerk: vi.fn(() => ({ setActive: mockSetActive })),
  useOrganization: vi.fn(() => ({ organization: { id: "current-org-id" } })),
  useOrganizationList: vi.fn(() => ({
    userMemberships: {
      data: [{ organization: { id: "other-org-id" } }],
    },
  })),
  useUser: vi.fn(() => ({ user: null })),
  useAuth: vi.fn(() => ({ getToken: vi.fn().mockResolvedValue("test-token") })),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn().mockResolvedValue({
    userId: "user_test",
    orgId: "org_test",
    orgRole: "org:admin",
    orgSlug: "test-org",
    getToken: async () => "test-token",
  }),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => ({ get: () => undefined })),
}));

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: mockPush, refresh: vi.fn(), replace: vi.fn() })),
  usePathname: vi.fn(() => "/settings"),
  useSearchParams: vi.fn(() => ({ get: () => null })),
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));

// ── Mock server actions ───────────────────────────────────────────────────────

const mockFetchDeletePreview = vi.fn();
const mockDeleteWorkspace = vi.fn();

vi.mock("../actions", () => ({
  fetchDeletePreview: (...args: unknown[]) => mockFetchDeletePreview(...args),
  deleteWorkspace: (...args: unknown[]) => mockDeleteWorkspace(...args),
}));

vi.mock("../../../../lib/api", () => ({
  apiFetch: vi.fn(),
}));

vi.mock("../../../../lib/theme", () => ({
  parseTheme: vi.fn(() => "system"),
}));

vi.mock("../../../../components/theme/ThemeSwitch", () => ({
  ThemeSwitch: () => React.createElement("div", null, "ThemeSwitch"),
}));

beforeEach(() => {
  mockSetActive.mockReset();
  mockPush.mockReset();
  mockFetchDeletePreview.mockReset();
  mockDeleteWorkspace.mockReset();
  vi.restoreAllMocks();
});

import { WorkspaceDeleteSection } from "../WorkspaceDeleteSection";

// ── WorkspaceDeleteSection ────────────────────────────────────────────────────

describe("WorkspaceDeleteSection", () => {
  const orgName = "My Test Org";

  it("renders delete workspace button", () => {
    render(<WorkspaceDeleteSection orgName={orgName} />);
    expect(screen.getByRole("button", { name: /delete workspace/i })).toBeDefined();
  });

  it("opens dialog when delete button is clicked", async () => {
    mockFetchDeletePreview.mockResolvedValue({ preview: { apps: 2, keys: 1, pending_invites: 0 } });
    render(<WorkspaceDeleteSection orgName={orgName} />);
    fireEvent.click(screen.getByRole("button", { name: /delete workspace/i }));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeDefined();
    });
  });

  it("submit button is disabled until name matches (M1 kill: always-enabled → test fails)", async () => {
    mockFetchDeletePreview.mockResolvedValue({ preview: { apps: 1, keys: 0, pending_invites: 0 } });
    render(<WorkspaceDeleteSection orgName={orgName} />);
    fireEvent.click(screen.getByRole("button", { name: /delete workspace/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());

    // Find submit button in dialog (the one inside the form)
    const dialog = screen.getByRole("dialog");
    const submitButton = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete workspace"),
    ) as HTMLButtonElement;
    expect(submitButton).toBeDefined();
    // Before typing anything, the submit button must be disabled
    expect(submitButton.disabled).toBe(true);

    // Type wrong name — still disabled
    const input = screen.getByPlaceholderText(orgName);
    fireEvent.change(input, { target: { value: "wrong name" } });
    expect(submitButton.disabled).toBe(true);

    // Type exact name — now enabled
    fireEvent.change(input, { target: { value: orgName } });
    expect(submitButton.disabled).toBe(false);
  });

  it("calls deleteWorkspace, then setActive with another workspace on success", async () => {
    mockFetchDeletePreview.mockResolvedValue({ preview: { apps: 1, keys: 0, pending_invites: 0 } });
    mockDeleteWorkspace.mockResolvedValue({});
    mockSetActive.mockResolvedValue(undefined);

    render(<WorkspaceDeleteSection orgName={orgName} />);
    fireEvent.click(screen.getByRole("button", { name: /delete workspace/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());

    const input = screen.getByPlaceholderText(orgName);
    fireEvent.change(input, { target: { value: orgName } });

    const dialog = screen.getByRole("dialog");
    const submitButton = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete workspace"),
    ) as HTMLButtonElement;

    fireEvent.click(submitButton);

    await waitFor(() => expect(mockDeleteWorkspace).toHaveBeenCalledWith(orgName));
    await waitFor(() =>
      expect(mockSetActive).toHaveBeenCalledWith({
        organization: "other-org-id",
        redirectUrl: "/apps",
      }),
    );
  });

  it("navigates to /onboarding when no other workspaces exist after delete", async () => {
    const { useOrganizationList } = await import("@clerk/nextjs");
    vi.mocked(useOrganizationList).mockReturnValue({
      userMemberships: { data: [] },
    } as unknown as ReturnType<typeof useOrganizationList>);

    mockFetchDeletePreview.mockResolvedValue({ preview: { apps: 0, keys: 0, pending_invites: 0 } });
    mockDeleteWorkspace.mockResolvedValue({});

    render(<WorkspaceDeleteSection orgName={orgName} />);
    fireEvent.click(screen.getByRole("button", { name: /delete workspace/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());

    const input = screen.getByPlaceholderText(orgName);
    fireEvent.change(input, { target: { value: orgName } });

    const dialog = screen.getByRole("dialog");
    const submitButton = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete workspace"),
    ) as HTMLButtonElement;
    fireEvent.click(submitButton);

    await waitFor(() => expect(mockDeleteWorkspace).toHaveBeenCalledWith(orgName));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/onboarding"));
  });

  it("shows error when deleteWorkspace returns name_mismatch", async () => {
    mockFetchDeletePreview.mockResolvedValue({ preview: { apps: 0, keys: 0, pending_invites: 0 } });
    mockDeleteWorkspace.mockResolvedValue({ error: "name_mismatch" });

    render(<WorkspaceDeleteSection orgName={orgName} />);
    fireEvent.click(screen.getByRole("button", { name: /delete workspace/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());

    const input = screen.getByPlaceholderText(orgName);
    fireEvent.change(input, { target: { value: orgName } });

    const dialog = screen.getByRole("dialog");
    const submitButton = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete workspace"),
    ) as HTMLButtonElement;
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("does not match");
    });
  });

  it("cancel button closes dialog", async () => {
    mockFetchDeletePreview.mockResolvedValue({ preview: { apps: 0, keys: 0, pending_invites: 0 } });
    render(<WorkspaceDeleteSection orgName={orgName} />);
    fireEvent.click(screen.getByRole("button", { name: /delete workspace/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());

    const dialog = screen.getByRole("dialog");
    const cancelButton = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent === "Cancel",
    ) as HTMLButtonElement;
    fireEvent.click(cancelButton);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

// ── Settings page admin guard (M2 kill) ───────────────────────────────────────

import SettingsPage from "../page";

describe("SettingsPage admin guard", () => {
  it("renders WorkspaceDeleteSection for org:admin (M2 kill: rendered for everyone → non-admins see danger zone)", async () => {
    const { auth } = await import("@clerk/nextjs/server");
    vi.mocked(auth).mockResolvedValueOnce({
      userId: "user_admin",
      orgId: "org_test",
      orgRole: "org:admin",
      orgSlug: "acme",
      getToken: async () => "test-token",
    } as Awaited<ReturnType<typeof auth>>);

    const result = await SettingsPage();
    // The WorkspaceDeleteSection receives orgName prop — present in JSX tree for admin
    const html = JSON.stringify(result);
    expect(html).toContain('"orgName"');
  });

  it("does NOT render WorkspaceDeleteSection for non-admin (M2 kill: rendered for everyone)", async () => {
    const { auth } = await import("@clerk/nextjs/server");
    vi.mocked(auth).mockResolvedValueOnce({
      userId: "user_member",
      orgId: "org_test",
      orgRole: "org:member",
      orgSlug: "acme",
      getToken: async () => "test-token",
    } as Awaited<ReturnType<typeof auth>>);

    const result = await SettingsPage();
    const html = JSON.stringify(result);
    // No orgName prop in the tree = WorkspaceDeleteSection not rendered
    expect(html).not.toContain('"orgName"');
  });
});
