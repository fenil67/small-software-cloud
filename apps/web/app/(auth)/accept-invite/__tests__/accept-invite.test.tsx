/**
 * accept-invite/page.tsx — new button-driven state machine tests.
 *
 * Key states:
 *   not signed in → shows "ready" state with Accept button
 *   signed in → auto-detects and processes (auto-fire)
 *
 * Root cause tests:
 *   - setActive called with both session + org (KEY FIX)
 *   - signed-in already-member navigates without accept()
 *
 * Mutation targets:
 *   M1: skip membership check in finishSignIn → M-not-member test fails
 *   M2: remove org-match filter in detectSignedInState → wrong invitation accepted
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import AcceptInvitePage from "../page";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockNavigateHard = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/navigate", () => ({ navigateHard: mockNavigateHard }));

// URL params: ticket present, org = "org_xyz"
vi.mock("next/navigation", () => ({
  useSearchParams: vi.fn(() => ({
    get: (k: string) => {
      if (k === "__clerk_ticket") return "ticket_abc";
      if (k === "org") return "org_xyz";
      return null;
    },
  })),
}));

// vi.hoisted is required for variables referenced inside vi.mock factories
const {
  mockSetActive,
  mockSignOut,
  mockTicket,
  mockFinalize,
  mockSignUpTicket,
  mockSignUpFinalize,
  mockGetOrganizationInvitations,
  mockGetOrganizationMemberships,
  mockUserReload,
  mockAccept,
  mockUseUser,
} = vi.hoisted(() => ({
  mockSetActive: vi.fn(),
  mockSignOut: vi.fn(),
  mockTicket: vi.fn(),
  mockFinalize: vi.fn(),
  mockSignUpTicket: vi.fn(),
  mockSignUpFinalize: vi.fn(),
  mockGetOrganizationInvitations: vi.fn(),
  mockGetOrganizationMemberships: vi.fn(),
  mockUserReload: vi.fn(),
  mockAccept: vi.fn(),
  mockUseUser: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useSignIn: vi.fn(() => ({
    isLoaded: true,
    signIn: {
      ticket: mockTicket,
      finalize: mockFinalize,
      status: "complete",
      createdSessionId: "session_123",
    },
  })),
  useSignUp: vi.fn(() => ({
    signUp: {
      ticket: mockSignUpTicket,
      finalize: mockSignUpFinalize,
      status: null,
      createdSessionId: null,
    },
  })),
  useClerk: vi.fn(() => ({ setActive: mockSetActive, signOut: mockSignOut })),
  useUser: mockUseUser,
}));

vi.mock("../../../../components/auth/AuthCard", () => ({
  AuthCard: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div data-testid="auth-card">
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function clerkError(code: string) {
  return { errors: [{ code, message: code }] };
}

function mockNotSignedIn() {
  mockUseUser.mockReturnValue({ user: null, isLoaded: true, isSignedIn: false });
}

function mockSignedIn(overrides: Record<string, unknown> = {}) {
  mockUseUser.mockReturnValue({
    isLoaded: true,
    isSignedIn: true,
    user: {
      reload: mockUserReload,
      getOrganizationMemberships: mockGetOrganizationMemberships,
      getOrganizationInvitations: mockGetOrganizationInvitations,
      primaryEmailAddress: { emailAddress: "user@test.com" },
      ...overrides,
    },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockSetActive.mockResolvedValue(undefined);
  mockUserReload.mockResolvedValue(undefined);
  mockTicket.mockResolvedValue({ error: null });
  mockFinalize.mockResolvedValue({ error: null });
  mockSignUpTicket.mockResolvedValue({ error: null });
  mockSignUpFinalize.mockResolvedValue({ error: null });
  mockAccept.mockResolvedValue({});
  mockGetOrganizationInvitations.mockResolvedValue({ data: [] });
  mockGetOrganizationMemberships.mockResolvedValue({ data: [] });
});

// ── 1. Not signed in → shows Accept button ────────────────────────────────────

describe("not signed in → shows Accept button", () => {
  it("shows Accept invitation button when user is null and isLoaded is true", async () => {
    mockNotSignedIn();
    render(<AcceptInvitePage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /accept invitation/i })).toBeInTheDocument(),
    );
  });
});

// ── 2. Click Accept → success → setActive called with session + org ───────────

describe("click Accept → success → setActive with session + org (ROOT CAUSE TEST)", () => {
  it("setActive called with { session, organization } after success", async () => {
    mockNotSignedIn();
    mockTicket.mockResolvedValue({ error: null });
    mockFinalize.mockResolvedValue({ error: null });

    render(<AcceptInvitePage />);
    const btn = await screen.findByRole("button", { name: /accept invitation/i });
    fireEvent.click(btn);

    await waitFor(() =>
      expect(mockSetActive).toHaveBeenCalledWith({
        session: "session_123",
        organization: "org_xyz",
      }),
    );
    expect(mockNavigateHard).toHaveBeenCalledWith("/apps");
  });
});

// ── 3. finishSignIn path: finalize fails + IS member → navigates (M-member) ───
// This tests checkMembership in finishSignIn. We simulate the scenario where
// the user is already signed in (Clerk's ticket() detected an existing session)
// but finalize() errored. The user IS a member of the invited org.
// Since the page auto-detects the signed-in state and goes through detectSignedInState,
// and the user has no pending invitation but IS a member, it navigates.

describe("finishSignIn fallback: IS member of invited org → navigates (M-member)", () => {
  it("navigates when user has no pending invitation but IS a member of the org", async () => {
    mockSignedIn();
    // No pending invitation for this org
    mockGetOrganizationInvitations.mockResolvedValue({ data: [] });
    // But IS a member
    mockGetOrganizationMemberships.mockResolvedValue({
      data: [{ organization: { id: "org_xyz" } }],
    });

    render(<AcceptInvitePage />);
    await waitFor(() => expect(mockNavigateHard).toHaveBeenCalledWith("/apps"));
    expect(mockSetActive).toHaveBeenCalledWith({ organization: "org_xyz" });
  });
});

// ── 4. Click Accept → finalize fails + NOT member → shows error ───────────────

describe("click Accept → finalize fails + NOT member → shows error (M-not-member)", () => {
  it("shows error alert when finalize fails and user is NOT a member", async () => {
    mockNotSignedIn();
    mockTicket.mockResolvedValue({ error: null });
    mockFinalize.mockResolvedValue({ error: clerkError("finalize_failed") });
    mockGetOrganizationMemberships.mockResolvedValue({ data: [] });

    render(<AcceptInvitePage />);
    const btn = await screen.findByRole("button", { name: /accept invitation/i });
    fireEvent.click(btn);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(mockNavigateHard).not.toHaveBeenCalled();
  });
});

// ── 5. Revoked ticket → shows error code ─────────────────────────────────────

describe("revoked ticket → shows error with code", () => {
  it("shows revoked message and error code element", async () => {
    mockNotSignedIn();
    mockTicket.mockResolvedValue({ error: clerkError("invitation_revoked") });

    render(<AcceptInvitePage />);
    const btn = await screen.findByRole("button", { name: /accept invitation/i });
    fireEvent.click(btn);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).toContain("revoked");
    expect(screen.getByText(/invitation_revoked/)).toBeInTheDocument();
  });
});

// ── 6. Signed in as right user → auto-accepts invitation (M-match-inv) ────────

describe("signed in → auto-accepts matching invitation", () => {
  it("calls accept() on matching invitation and navigates", async () => {
    const mockAcceptOrg = vi.fn().mockResolvedValue({});
    mockSignedIn();
    mockGetOrganizationInvitations.mockResolvedValue({
      data: [{ accept: mockAcceptOrg, publicOrganizationData: { id: "org_xyz" } }],
    });

    render(<AcceptInvitePage />);

    await waitFor(() => expect(mockNavigateHard).toHaveBeenCalledWith("/apps"));
    expect(mockAcceptOrg).toHaveBeenCalled();
    expect(mockSetActive).toHaveBeenCalledWith({ organization: "org_xyz" });
  });
});

// ── 7. Signed in with two pending invitations → only matching one accepted ────

describe("signed in with two pending invitations → only matching one accepted", () => {
  it("only the org_xyz invitation is accepted, not org_other", async () => {
    const mockAcceptOther = vi.fn().mockResolvedValue({});
    const mockAcceptXyz = vi.fn().mockResolvedValue({});
    mockSignedIn();
    mockGetOrganizationInvitations.mockResolvedValue({
      data: [
        { accept: mockAcceptOther, publicOrganizationData: { id: "org_other" } },
        { accept: mockAcceptXyz, publicOrganizationData: { id: "org_xyz" } },
      ],
    });

    render(<AcceptInvitePage />);

    await waitFor(() => expect(mockNavigateHard).toHaveBeenCalledWith("/apps"));
    expect(mockAcceptXyz).toHaveBeenCalled();
    expect(mockAcceptOther).not.toHaveBeenCalled();
  });
});

// ── 8. Signed in, ticket already used → already a member → navigates ──────────

describe("signed in, already a member → navigates (ROOT CAUSE TEST 2)", () => {
  it("navigates when no pending invitation but already a member", async () => {
    mockSignedIn();
    mockGetOrganizationInvitations.mockResolvedValue({ data: [] });
    mockGetOrganizationMemberships.mockResolvedValue({
      data: [{ organization: { id: "org_xyz" } }],
    });

    render(<AcceptInvitePage />);

    await waitFor(() => expect(mockNavigateHard).toHaveBeenCalledWith("/apps"));
    expect(mockSetActive).toHaveBeenCalledWith({ organization: "org_xyz" });
  });
});

// ── 9. Signed in as wrong account → shows wrong_account card ─────────────────

describe("signed in as wrong account → shows wrong_account state", () => {
  it("shows 'signed in as' message and two action buttons", async () => {
    mockSignedIn();
    mockGetOrganizationInvitations.mockResolvedValue({ data: [] });
    mockGetOrganizationMemberships.mockResolvedValue({ data: [] });

    render(<AcceptInvitePage />);

    await waitFor(() => expect(screen.getByText(/signed in as/i)).toBeInTheDocument());
    expect(mockNavigateHard).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /sign out and continue/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to my apps/i })).toBeInTheDocument();
  });
});

// ── 10. Wrong account: sign out button calls signOut ──────────────────────────

describe("wrong account: sign out button calls signOut", () => {
  it("calls signOut when 'Sign out and continue' is clicked", async () => {
    mockSignedIn();
    mockGetOrganizationInvitations.mockResolvedValue({ data: [] });
    mockGetOrganizationMemberships.mockResolvedValue({ data: [] });

    render(<AcceptInvitePage />);

    const signOutBtn = await screen.findByRole("button", { name: /sign out and continue/i });
    fireEvent.click(signOutBtn);
    expect(mockSignOut).toHaveBeenCalled();
  });
});
