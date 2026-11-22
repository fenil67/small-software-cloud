/**
 * Settings page — WorkspaceDeleteSection tests
 *
 * M1 kill: "submit button disabled until name matches" — canDelete guard must gate on name equality
 * M2 kill: "danger zone hidden for non-admins" — settings page must not render WorkspaceDeleteSection when isAdmin=false
 * M-nav-target: target chosen pre-delete must exclude current org; if post-delete target includes deleted → test fails
 * M-nav-timeout: Promise.race timeout must exist; if removed → setActive-hangs test fails
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";
// vi.mock("@clerk/nextjs", …) is hoisted before all imports, so this gets the mock.
import { useUser as clerkUseUser } from "@clerk/nextjs";

// ── Mock Clerk client hooks ───────────────────────────────────────────────────

const mockSetActive = vi.fn();
const mockSignOut   = vi.fn();

vi.mock("@clerk/nextjs", () => ({
  useClerk: vi.fn(() => ({ setActive: mockSetActive, signOut: mockSignOut })),
  useOrganization: vi.fn(() => ({ organization: { id: "current-org-id" } })),
  useOrganizationList: vi.fn(() => ({
    userMemberships: {
      // current-org-id is first so mutation A (no filter) would pick it, not other-org-id
      data: [
        { organization: { id: "current-org-id" } },
        { organization: { id: "other-org-id" } },
      ],
    },
  })),
  useUser: vi.fn(() => ({ user: null, isLoaded: false })),
  useAuth: vi.fn(() => ({ getToken: vi.fn().mockResolvedValue("test-token") })),
  useSession: vi.fn(() => ({ session: null })),
  useSessionList: vi.fn(() => ({ sessions: [], isLoaded: true })),
  // useReverification: wraps fetcher; in tests just calls it directly (no reverification interception)
  useReverification: vi.fn((fetcher: (...args: unknown[]) => Promise<unknown>, options?: { onNeedsReverification?: (p: { cancel: () => void; complete: () => void; level?: string }) => void }) => {
    return async (...args: unknown[]) => {
      return fetcher(...args);
    };
  }),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn().mockResolvedValue({
    userId: "user_test",
    orgId: "org_test",
    orgRole: "org:admin",
    orgSlug: "test-org",
    getToken: async () => "test-token",
  }),
  clerkClient: vi.fn().mockResolvedValue({
    organizations: {
      getOrganization: vi.fn().mockResolvedValue({ name: "My Test Org" }),
    },
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
const mockDeleteWorkspace    = vi.fn();
const mockDeleteAccount      = vi.fn();

vi.mock("../actions", () => ({
  fetchDeletePreview: (...args: unknown[]) => mockFetchDeletePreview(...args),
  deleteWorkspace:    (...args: unknown[]) => mockDeleteWorkspace(...args),
  deleteAccount:      (...args: unknown[]) => mockDeleteAccount(...args),
}));

vi.mock("../../../../components/auth/CodeStep", () => ({
  CodeStep: ({ email, code, onChange, onSubmit, loading, submitLabel }: {
    email: string;
    code: string;
    onChange: (v: string) => void;
    onSubmit: () => void;
    loading?: boolean;
    submitLabel?: string;
  }) => React.createElement(
    "div",
    null,
    React.createElement("span", null, `code-step:${email}`),
    React.createElement("input", {
      "data-testid": "code-input",
      value: code,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
    }),
    React.createElement("button", { onClick: onSubmit, disabled: loading }, submitLabel ?? "Verify"),
  ),
}));

// ReverificationDialog is mocked to expose a simple dialog stub in tests.
// Real session methods are not available in the test environment.
vi.mock("../ReverificationDialog", () => ({
  ReverificationDialog: ({ onVerified, onCancel }: { onVerified: () => void; onCancel: () => void }) =>
    React.createElement(
      "div",
      { role: "dialog", "aria-label": "reverification-dialog" },
      React.createElement("button", { onClick: onVerified }, "Verify identity"),
      React.createElement("button", { onClick: onCancel }, "Cancel reverification"),
    ),
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

// ── Mock navigate helper ──────────────────────────────────────────────────────

const mockNavigateHard = vi.fn();

vi.mock("../../../../lib/navigate", () => ({
  navigateHard: (...args: unknown[]) => mockNavigateHard(...args),
}));

beforeEach(() => {
  mockSetActive.mockReset();
  mockSignOut.mockReset();
  mockPush.mockReset();
  mockFetchDeletePreview.mockReset();
  mockDeleteWorkspace.mockReset();
  mockDeleteAccount.mockReset();
  mockNavigateHard.mockReset();
  (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: null, isLoaded: false });
});

afterEach(() => {
  vi.useRealTimers();
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

  it("calls deleteWorkspace, then setActive (no redirectUrl) + navigateHard('/apps') on success", async () => {
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
    // setActive called WITHOUT redirectUrl — navigation is explicit via navigateHard
    await waitFor(() =>
      expect(mockSetActive).toHaveBeenCalledWith({ organization: "other-org-id" }),
    );
    await waitFor(() => expect(mockNavigateHard).toHaveBeenCalledWith("/apps"));
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
    await waitFor(() => expect(mockNavigateHard).toHaveBeenCalledWith("/onboarding"));
  });

  it("navigates to /apps after 5s even when setActive never resolves (M-nav-timeout: remove timeout → test hangs/fails)", async () => {
    // Restore default useOrganizationList (previous test may have set it to empty)
    const { useOrganizationList } = await import("@clerk/nextjs");
    vi.mocked(useOrganizationList).mockReturnValue({
      userMemberships: { data: [{ organization: { id: "other-org-id" } }] },
    } as unknown as ReturnType<typeof useOrganizationList>);

    mockFetchDeletePreview.mockResolvedValue({ preview: { apps: 1, keys: 0, pending_invites: 0 } });
    mockDeleteWorkspace.mockResolvedValue({});
    // setActive returns a promise that never resolves — simulates Clerk hang
    mockSetActive.mockReturnValue(new Promise<void>(() => {}));

    // Open dialog and type name using REAL timers so waitFor works
    render(<WorkspaceDeleteSection orgName={orgName} />);
    fireEvent.click(screen.getByRole("button", { name: /delete workspace/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());

    const input = screen.getByPlaceholderText(orgName);
    fireEvent.change(input, { target: { value: orgName } });

    const dialog = screen.getByRole("dialog");
    const submitButton = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete workspace"),
    ) as HTMLButtonElement;

    // Switch to fake timers NOW — only the setTimeout(r, 5000) needs faking
    vi.useFakeTimers();

    fireEvent.click(submitButton);
    // Flush microtasks: deleteWorkspace resolves, setActive called but hangs
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());

    // setActive has not resolved — navigateHard must NOT have fired yet
    expect(mockNavigateHard).not.toHaveBeenCalled();

    // Advance past the 5-second timeout, then flush the continuation microtasks
    // that run navigateHard after Promise.race settles.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    // The Promise.race resolution schedules a microtask for the next line
    // (navigateHard). Flush it.
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());

    expect(mockNavigateHard).toHaveBeenCalledWith("/apps");
  }, 15_000);

  it("shows error and re-enables buttons when API returns an error (never stuck on Deleting...)", async () => {
    mockFetchDeletePreview.mockResolvedValue({ preview: { apps: 1, keys: 0, pending_invites: 0 } });
    mockDeleteWorkspace.mockResolvedValue({ error: "forbidden" });

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

    // Error message shown
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Could not delete workspace");
    });

    // navigateHard never called — we're still in the dialog
    expect(mockNavigateHard).not.toHaveBeenCalled();

    // Submit button is re-enabled (deleting transition ended)
    await waitFor(() => {
      const btn = Array.from(screen.getByRole("dialog").querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Delete workspace"),
      ) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
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

// ── WorkspaceDeleteSection: display name vs slug (M-web-name kills) ───────────
//
// The dialog must show the Clerk display name, not the org slug.
// Mutation kill: when page.tsx passes orgSlug instead of org.name,
// "My Organization" no longer appears in the dialog → "typing display name enables
// delete" fails because the button stays disabled.

describe("WorkspaceDeleteSection slug vs display name", () => {
  const displayName = "My Organization";
  const orgSlug    = "my-organization-abc123"; // distinct from display name

  async function openDialog() {
    mockFetchDeletePreview.mockResolvedValue({ preview: { apps: 1, keys: 0, pending_invites: 0 } });
    render(<WorkspaceDeleteSection orgName={displayName} />);
    fireEvent.click(screen.getByRole("button", { name: /delete workspace/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
  }

  function getSubmitButton(): HTMLButtonElement {
    const dialog = screen.getByRole("dialog");
    return Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete workspace"),
    ) as HTMLButtonElement;
  }

  it("dialog label shows the Clerk display name, not the slug (M-web-name: pass orgSlug → 'My Organization' missing → test fails)", async () => {
    await openDialog();
    // The <label> shows: Type <strong>{orgName}</strong> to confirm
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(displayName);
    expect(dialog.textContent).not.toContain(orgSlug);
  });

  it("typing the slug keeps the submit button disabled (M-web-name: slug accepted → test fails)", async () => {
    await openDialog();
    const input = screen.getByPlaceholderText(displayName);
    fireEvent.change(input, { target: { value: orgSlug } });
    expect(getSubmitButton().disabled).toBe(true);
  });

  it("typing the exact display name enables the submit button (M-web-name: compares against slug → stays disabled)", async () => {
    await openDialog();
    const input = screen.getByPlaceholderText(displayName);
    fireEvent.change(input, { target: { value: displayName } });
    expect(getSubmitButton().disabled).toBe(false);
  });

  it('"  My Organization  " with surrounding spaces is accepted (trimmed before comparison)', async () => {
    await openDialog();
    const input = screen.getByPlaceholderText(displayName);
    fireEvent.change(input, { target: { value: `  ${displayName}  ` } });
    expect(getSubmitButton().disabled).toBe(false);
  });

  it("submit button carries the HTML disabled attribute (not only visual styling) until name matches", async () => {
    await openDialog();
    const btn = getSubmitButton();
    // Before typing: must have the disabled attribute
    expect(btn.hasAttribute("disabled")).toBe(true);
    // After typing exact name: attribute removed
    const input = screen.getByPlaceholderText(displayName);
    fireEvent.change(input, { target: { value: displayName } });
    expect(btn.hasAttribute("disabled")).toBe(false);
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

  it("passes Clerk display name (not orgSlug) as orgName (M-web-name: pass orgSlug → 'My Organization' missing → test fails)", async () => {
    const { auth, clerkClient } = await import("@clerk/nextjs/server");
    vi.mocked(auth).mockResolvedValueOnce({
      userId: "user_admin",
      orgId: "org_test",
      orgRole: "org:admin",
      orgSlug: "my-organization-abc123", // slug is distinct from the display name
      getToken: async () => "test-token",
    } as Awaited<ReturnType<typeof auth>>);
    vi.mocked(clerkClient).mockResolvedValueOnce({
      organizations: {
        getOrganization: vi.fn().mockResolvedValue({ name: "My Organization" }),
      },
    } as unknown as Awaited<ReturnType<typeof clerkClient>>);

    const result = await SettingsPage();
    const html = JSON.stringify(result);
    // orgName must be the Clerk display name — NOT the slug
    expect(html).toContain("My Organization");
    expect(html).not.toContain("my-organization-abc123");
  });
});

// ── ProfileSection ────────────────────────────────────────────────────────────

import { ProfileSection } from "../ProfileSection";

const mockUserUpdate = vi.fn();
const mockSetProfileImage = vi.fn();

function makeProfileUser(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "user_1",
    firstName: "Jane",
    lastName: "Doe",
    username: "janedoe",
    imageUrl: "https://img.clerk.com/test.jpg",
    hasImage: true,
    emailAddresses: [{ id: "ea1", emailAddress: "jane@test.com", verification: { status: "verified" } }],
    update: mockUserUpdate,
    setProfileImage: mockSetProfileImage,
    ...overrides,
  };
}

describe("ProfileSection", () => {
  it("renders with current profile values", () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeProfileUser(), isLoaded: true });
    render(<ProfileSection />);
    expect((screen.getByLabelText(/first name/i) as HTMLInputElement).value).toBe("Jane");
    expect((screen.getByLabelText(/last name/i) as HTMLInputElement).value).toBe("Doe");
  });

  it("Save button disabled until a field changes", () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeProfileUser(), isLoaded: true });
    render(<ProfileSection />);
    const btn = screen.getByRole("button", { name: /save changes/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("Save button enabled after changing first name", () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeProfileUser(), isLoaded: true });
    render(<ProfileSection />);
    fireEvent.change(screen.getByLabelText(/first name/i), { target: { value: "Janet" } });
    const btn = screen.getByRole("button", { name: /save changes/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("maps Clerk username-taken error to plain message", async () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeProfileUser(), isLoaded: true });
    mockUserUpdate.mockRejectedValueOnce({
      errors: [{ message: "That username is already taken. Please choose another." }],
    });
    render(<ProfileSection />);
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "taken" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("already taken");
      expect(alert.textContent).not.toContain("Please choose another");
    });
  });

  it("rejects non-image file with plain error message", () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeProfileUser(), isLoaded: true });
    render(<ProfileSection />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const pdfFile = new File(["content"], "doc.pdf", { type: "application/pdf" });
    Object.defineProperty(fileInput, "files", { value: [pdfFile], writable: false });
    fireEvent.change(fileInput);
    expect(screen.getByRole("alert").textContent).toContain("image file");
  });

  it("rejects file over 10 MB with plain error message", () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeProfileUser(), isLoaded: true });
    render(<ProfileSection />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const bigFile = new File([new ArrayBuffer(11 * 1024 * 1024)], "big.jpg", { type: "image/jpeg" });
    Object.defineProperty(fileInput, "files", { value: [bigFile], writable: false });
    fireEvent.change(fileInput);
    expect(screen.getByRole("alert").textContent).toContain("10 MB");
  });
});

// ── EmailSection ──────────────────────────────────────────────────────────────

import { EmailSection } from "../EmailSection";

const mockEmailDestroy      = vi.fn();
const mockEmailMakePrimary  = vi.fn();

function makeEmailUser(opts?: { emails?: unknown[]; primaryId?: string }) {
  const emails = opts?.emails ?? [
    {
      id: "ea_primary",
      emailAddress: "primary@test.com",
      verification: { status: "verified" },
      destroy: mockEmailDestroy,
      prepareVerification: vi.fn().mockResolvedValue(undefined),
      attemptVerification: vi.fn().mockResolvedValue(undefined),
      makeDefaultPrimary: mockEmailMakePrimary,
    },
    {
      id: "ea_other",
      emailAddress: "other@test.com",
      verification: { status: "verified" },
      destroy: mockEmailDestroy,
      prepareVerification: vi.fn().mockResolvedValue(undefined),
      attemptVerification: vi.fn().mockResolvedValue(undefined),
      makeDefaultPrimary: mockEmailMakePrimary,
    },
  ];
  return {
    id: "user_1",
    emailAddresses: emails,
    primaryEmailAddressId: opts?.primaryId ?? "ea_primary",
    createEmailAddress: vi.fn().mockResolvedValue({
      emailAddress: "new@test.com",
      prepareVerification: vi.fn().mockResolvedValue(undefined),
      attemptVerification: vi.fn().mockResolvedValue(undefined),
    }),
    update: vi.fn().mockResolvedValue(undefined),
  };
}

describe("EmailSection", () => {
  it("renders email list with Primary and Verified badges", () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeEmailUser(), isLoaded: true });
    render(<EmailSection />);
    expect(screen.getByText("primary@test.com")).toBeDefined();
    expect(screen.getByText("other@test.com")).toBeDefined();
    expect(screen.getByText("Primary")).toBeDefined();
  });

  it("cannot remove primary email (M-ME-primary kill: remove guard → remove button shown → test fails)", () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeEmailUser(), isLoaded: true });
    render(<EmailSection />);
    // Primary email row should NOT have a Remove button
    const primaryRow = screen.getByText("primary@test.com").closest("div")!.parentElement!;
    const removeButtons = Array.from(primaryRow.querySelectorAll("button")).filter(
      (b) => b.textContent?.toLowerCase().includes("remove"),
    );
    expect(removeButtons).toHaveLength(0);
  });

  it("cannot remove the only email", () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({
      user: makeEmailUser({
        emails: [{
          id: "ea_only",
          emailAddress: "only@test.com",
          verification: { status: "verified" },
          destroy: mockEmailDestroy,
          prepareVerification: vi.fn().mockResolvedValue(undefined),
          attemptVerification: vi.fn().mockResolvedValue(undefined),
          makeDefaultPrimary: mockEmailMakePrimary,
        }],
        primaryId: "ea_only",
      }),
      isLoaded: true,
    });
    render(<EmailSection />);
    const removeButtons = screen.queryAllByText("Remove");
    expect(removeButtons).toHaveLength(0);
  });

  it("non-primary verified email shows Make primary and Remove buttons", () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeEmailUser(), isLoaded: true });
    render(<EmailSection />);
    expect(screen.getByRole("button", { name: /make other@test.com primary/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /remove other@test.com/i })).toBeDefined();
  });
});

// ── ConnectedAccountsSection ──────────────────────────────────────────────────

import { ConnectedAccountsSection } from "../ConnectedAccountsSection";

const mockExtDestroy = vi.fn();

function makeConnectedUser(opts?: {
  externalAccounts?: unknown[];
  verifiedEmails?: number;
}) {
  const verifiedEmails = opts?.verifiedEmails ?? 1;
  return {
    id: "user_1",
    externalAccounts: opts?.externalAccounts ?? [
      {
        id: "ext_google",
        provider: "google",
        emailAddress: "user@gmail.com",
        destroy: mockExtDestroy,
      },
    ],
    emailAddresses: Array.from({ length: verifiedEmails }, (_, i) => ({
      id: `ea_${i}`,
      emailAddress: `user${i}@test.com`,
      verification: { status: "verified" },
    })),
    createExternalAccount: vi.fn().mockResolvedValue({
      verification: { externalVerificationRedirectURL: null },
    }),
  };
}

describe("ConnectedAccountsSection", () => {
  it("renders Google and GitHub rows", () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeConnectedUser(), isLoaded: true });
    render(<ConnectedAccountsSection />);
    expect(screen.getByText("Google")).toBeDefined();
    expect(screen.getByText("GitHub")).toBeDefined();
  });

  it("connected account shows Disconnect button", () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeConnectedUser(), isLoaded: true });
    render(<ConnectedAccountsSection />);
    expect(screen.getByRole("button", { name: /disconnect.*google/i })).toBeDefined();
  });

  it("cannot disconnect last sign-in method (M-ME-lastmethod kill: remove guard → button enabled → test fails)", () => {
    // User has ONLY Google connected and NO verified emails → Google is the last sign-in method
    (vi.mocked(clerkUseUser) as any).mockReturnValue({
      user: makeConnectedUser({ verifiedEmails: 0 }),
      isLoaded: true,
    });
    render(<ConnectedAccountsSection />);
    const disconnectBtn = screen.getByRole("button", { name: /disconnect.*google/i }) as HTMLButtonElement;
    expect(disconnectBtn.disabled).toBe(true);
  });

  it("can disconnect when another sign-in method exists", () => {
    // User has Google + a verified email → can disconnect Google
    (vi.mocked(clerkUseUser) as any).mockReturnValue({
      user: makeConnectedUser({ verifiedEmails: 1 }),
      isLoaded: true,
    });
    render(<ConnectedAccountsSection />);
    const disconnectBtn = screen.getByRole("button", { name: /disconnect.*google/i }) as HTMLButtonElement;
    expect(disconnectBtn.disabled).toBe(false);
  });

  it("unconnected provider shows Connect button", () => {
    // No external accounts → both Google and GitHub show Connect
    (vi.mocked(clerkUseUser) as any).mockReturnValue({
      user: makeConnectedUser({ externalAccounts: [], verifiedEmails: 1 }),
      isLoaded: true,
    });
    render(<ConnectedAccountsSection />);
    const connectBtns = screen.getAllByRole("button", { name: /^connect$/i });
    expect(connectBtns.length).toBeGreaterThanOrEqual(2);
  });
});

// ── DeleteAccountSection ──────────────────────────────────────────────────────

import { DeleteAccountSection } from "../DeleteAccountSection";

const PRIMARY_EMAIL = "owner@test.com";

function makeDeleteUser() {
  return {
    id: "user_del",
    primaryEmailAddress: { emailAddress: PRIMARY_EMAIL },
    isLoaded: true,
  };
}

describe("DeleteAccountSection", () => {
  it("renders delete account button", () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeDeleteUser(), isLoaded: true });
    render(<DeleteAccountSection />);
    expect(screen.getByRole("button", { name: /delete account/i })).toBeDefined();
  });

  it("dialog opens on click", async () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeDeleteUser(), isLoaded: true });
    render(<DeleteAccountSection />);
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(screen.getByRole("dialog").textContent).toContain(PRIMARY_EMAIL);
  });

  it("delete button disabled until email matches (M-confirm kill: remove guard → always enabled → fails)", async () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeDeleteUser(), isLoaded: true });
    render(<DeleteAccountSection />);
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());

    const dialog = screen.getByRole("dialog");
    const submitBtn = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete account"),
    ) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(PRIMARY_EMAIL), { target: { value: "wrong@test.com" } });
    expect(submitBtn.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(PRIMARY_EMAIL), { target: { value: PRIMARY_EMAIL } });
    expect(submitBtn.disabled).toBe(false);
  });

  it("calls deleteAccount with confirm email and navigates to /sign-in on success", async () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeDeleteUser(), isLoaded: true });
    mockDeleteAccount.mockResolvedValue({});
    render(<DeleteAccountSection />);
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());

    fireEvent.change(screen.getByPlaceholderText(PRIMARY_EMAIL), { target: { value: PRIMARY_EMAIL } });
    const dialog = screen.getByRole("dialog");
    const submitBtn = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete account"),
    ) as HTMLButtonElement;
    fireEvent.click(submitBtn);

    await waitFor(() => expect(mockDeleteAccount).toHaveBeenCalledWith(PRIMARY_EMAIL));
    await waitFor(() => expect(mockNavigateHard).toHaveBeenCalledWith("/sign-in"));
  });

  it("shows sole_admin_blocked list when API returns 409", async () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeDeleteUser(), isLoaded: true });
    mockDeleteAccount.mockResolvedValue({
      error: "sole_admin_blocked",
      blocked: {
        error: "sole_admin_blocked",
        message: "Make someone else admin first.",
        workspaces: [{ id: "ws1", name: "Acme Corp" }],
      },
    });
    render(<DeleteAccountSection />);
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());

    fireEvent.change(screen.getByPlaceholderText(PRIMARY_EMAIL), { target: { value: PRIMARY_EMAIL } });
    const dialog = screen.getByRole("dialog");
    const submitBtn = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete account"),
    ) as HTMLButtonElement;
    fireEvent.click(submitBtn);

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("Acme Corp");
    });
  });

  it("cancel button closes dialog", async () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeDeleteUser(), isLoaded: true });
    render(<DeleteAccountSection />);
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());

    const dialog = screen.getByRole("dialog");
    const cancelBtn = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent === "Cancel",
    ) as HTMLButtonElement;
    fireEvent.click(cancelBtn);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

// ── ProfileSection — error code mapping ──────────────────────────────────────

describe("ProfileSection – Clerk error code mapping", () => {
  it("maps form_identifier_exists (code) to 'already taken'", async () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeProfileUser(), isLoaded: true });
    mockUserUpdate.mockRejectedValueOnce({
      errors: [{ code: "form_identifier_exists", message: "identifier already exists" }],
    });
    render(<ProfileSection />);
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "taken" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("already taken");
    });
  });

  it("maps form_username_invalid_character to plain message", async () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeProfileUser(), isLoaded: true });
    mockUserUpdate.mockRejectedValueOnce({
      errors: [{ code: "form_username_invalid_character", message: "invalid chars" }],
    });
    render(<ProfileSection />);
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "bad!" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("letters, numbers, underscores");
    });
  });

  it("maps form_param_max_length_exceeded + 'first name' to 'First name is too long.'", async () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeProfileUser(), isLoaded: true });
    mockUserUpdate.mockRejectedValueOnce({
      errors: [{ code: "form_param_max_length_exceeded", message: "first name is too long" }],
    });
    render(<ProfileSection />);
    fireEvent.change(screen.getByLabelText(/first name/i), { target: { value: "A".repeat(200) } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("First name is too long");
    });
  });

  it("logs only the error code, not the message content (no PII in logs)", async () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeProfileUser(), isLoaded: true });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockUserUpdate.mockRejectedValueOnce({
      errors: [{ code: "form_identifier_exists", message: "pii:username_already_in_use@secret.com" }],
    });
    render(<ProfileSection />);
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "taken" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    const logs = errorSpy.mock.calls.flat().join(" ");
    expect(logs).toContain("form_identifier_exists");
    expect(logs).not.toContain("pii:username_already_in_use@secret.com");
    errorSpy.mockRestore();
  });
});

// ── ReverificationDialog ──────────────────────────────────────────────────────

import { ReverificationDialog } from "../ReverificationDialog";

describe("ReverificationDialog", () => {
  it("renders with Verify identity and Cancel buttons", () => {
    render(<ReverificationDialog onVerified={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByRole("button", { name: /verify identity/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /cancel reverification/i })).toBeDefined();
  });

  it("calls onVerified when Verify identity is clicked", () => {
    const mockVerified = vi.fn();
    render(<ReverificationDialog onVerified={mockVerified} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /verify identity/i }));
    expect(mockVerified).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when Cancel is clicked (M-reverif cancel: remove handler → stays open → fails)", () => {
    const mockCancel = vi.fn();
    render(<ReverificationDialog onVerified={vi.fn()} onCancel={mockCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel reverification/i }));
    expect(mockCancel).toHaveBeenCalledTimes(1);
  });
});

// ── DeleteAccountSection – reverification_required ───────────────────────────

describe("DeleteAccountSection – reverification_required", () => {
  it("shows reverification dialog when server returns reverification_required", async () => {
    (vi.mocked(clerkUseUser) as any).mockReturnValue({ user: makeDeleteUser(), isLoaded: true });
    mockDeleteAccount.mockResolvedValueOnce({ error: "reverification_required" });

    render(<DeleteAccountSection />);
    // Open the delete dialog
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());

    // Type the matching email and submit
    const confirmInput = screen.getByPlaceholderText("owner@test.com") as HTMLInputElement;
    fireEvent.change(confirmInput, { target: { value: "owner@test.com" } });

    // Find submit button inside the dialog
    const dialog = screen.getByRole("dialog");
    const submitBtn = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Delete account" && b.type === "submit",
    ) as HTMLButtonElement;
    expect(submitBtn).toBeDefined();
    await act(async () => { fireEvent.click(submitBtn); });

    // Reverification dialog should now replace the delete dialog
    await waitFor(() => {
      expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("reverification-dialog");
    });
  });
});
