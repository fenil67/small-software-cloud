/**
 * accept-invite/page.tsx — membership-checked idempotency and already-signed-in flow tests.
 *
 * M-member: finalize() fails; user IS a member of invited org → navigates
 * M-not-member: finalize() fails; user NOT a member → error shown, no navigation
 * M-match-inv: signed-in with two pending invitations → only org-matching one accepted
 * M-no-match: no matching invitation → "not for this account" error shown
 * M-invalid: truly invalid ticket → error shown, navigateHard NOT called
 * Mutation (M-member): skip membership check, always navigate on finalize failure → M-not-member test fails
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import React from "react";
import AcceptInvitePage from "../page";

// ── Module mocks ──────────────────────────────────────────────────────────────

// vi.mock is hoisted before variable declarations; use vi.hoisted for forward reference
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

const mockSetActive = vi.fn();
const mockSignOut = vi.fn();
const mockTicket = vi.fn();
const mockFinalize = vi.fn();
const mockSignUpTicket = vi.fn();
const mockSignUpFinalize = vi.fn();
const mockGetOrganizationInvitations = vi.fn();
const mockGetOrganizationMemberships = vi.fn();
const mockUserReload = vi.fn();

vi.mock("@clerk/nextjs", () => ({
  useSignIn: vi.fn(() => ({
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
  useUser: vi.fn(() => ({
    user: {
      reload: mockUserReload,
      getOrganizationMemberships: mockGetOrganizationMemberships,
      getOrganizationInvitations: mockGetOrganizationInvitations,
    },
  })),
}));

vi.mock("../../../../components/auth/AuthCard", () => ({
  AuthCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function clerkError(code: string) {
  return { errors: [{ code, message: code }] };
}

function membership(orgId: string) {
  return { organization: { id: orgId } };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// ── finalize() fails → membership check determines navigation ─────────────────

describe("finalize() fails after ticket() — membership check determines navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetActive.mockResolvedValue(undefined);
    mockUserReload.mockResolvedValue(undefined);
  });

  it("IS a member of invited org → navigates to /apps (M-member)", async () => {
    mockTicket.mockResolvedValue({ error: null });
    mockFinalize.mockResolvedValue({ error: clerkError("session_exists") });
    mockGetOrganizationMemberships.mockResolvedValue({
      data: [membership("org_xyz")],
    });

    render(<AcceptInvitePage />);

    await waitFor(() => expect(mockNavigateHard).toHaveBeenCalledWith("/apps"));
  });

  it("NOT a member of invited org → shows error, no navigation (M-not-member)", async () => {
    mockTicket.mockResolvedValue({ error: null });
    mockFinalize.mockResolvedValue({ error: clerkError("session_exists") });
    mockGetOrganizationMemberships.mockResolvedValue({
      data: [membership("org_other")], // different org, not invited one
    });

    const { getByRole } = render(<AcceptInvitePage />);

    await waitFor(() => expect(getByRole("alert")).toBeTruthy());
    expect(mockNavigateHard).not.toHaveBeenCalled();
  });

  it("checkMembership: activates session before checking memberships", async () => {
    mockTicket.mockResolvedValue({ error: null });
    mockFinalize.mockResolvedValue({ error: clerkError("session_exists") });
    mockGetOrganizationMemberships.mockResolvedValue({
      data: [membership("org_xyz")],
    });

    render(<AcceptInvitePage />);

    await waitFor(() => expect(mockNavigateHard).toHaveBeenCalledWith("/apps"));
    expect(mockSetActive).toHaveBeenCalledWith({ session: "session_123" });
    expect(mockUserReload).toHaveBeenCalled();
    expect(mockGetOrganizationMemberships).toHaveBeenCalled();
  });
});

// ── already signed-in user → org-matched invitation ───────────────────────────

describe("already signed-in user → matches invitation by org id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetActive.mockResolvedValue(undefined);
  });

  it("accepts the matching invitation from two pending ones (M-match-inv)", async () => {
    mockTicket.mockResolvedValue({ error: clerkError("identifier_already_signed_in") });
    const mockAcceptOther = vi.fn().mockResolvedValue({});
    const mockAcceptXyz = vi.fn().mockResolvedValue({});
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
    expect(mockSetActive).toHaveBeenCalledWith({ organization: "org_xyz" });
  });

  it("shows 'not for this account' when no invitation matches the link's org (M-no-match)", async () => {
    mockTicket.mockResolvedValue({ error: clerkError("identifier_already_signed_in") });
    const mockAcceptOther = vi.fn().mockResolvedValue({});
    mockGetOrganizationInvitations.mockResolvedValue({
      data: [{ accept: mockAcceptOther, publicOrganizationData: { id: "org_other" } }],
    });

    const { getByRole } = render(<AcceptInvitePage />);

    await waitFor(() => expect(getByRole("alert")).toBeTruthy());
    expect(getByRole("alert").textContent).toContain("not for this account");
    expect(mockAcceptOther).not.toHaveBeenCalled();
    expect(mockNavigateHard).not.toHaveBeenCalled();
  });

  it("shows 'not for this account' when pending invitations list is empty", async () => {
    mockTicket.mockResolvedValue({ error: clerkError("identifier_already_signed_in") });
    mockGetOrganizationInvitations.mockResolvedValue({ data: [] });

    const { getByRole } = render(<AcceptInvitePage />);

    await waitFor(() => expect(getByRole("alert")).toBeTruthy());
    expect(getByRole("alert").textContent).toContain("not for this account");
    expect(mockNavigateHard).not.toHaveBeenCalled();
  });

  it("navigates silently when matching invitation was already accepted", async () => {
    mockTicket.mockResolvedValue({ error: clerkError("identifier_already_signed_in") });
    const mockAccept = vi.fn().mockRejectedValue(clerkError("invitation_already_accepted"));
    mockGetOrganizationInvitations.mockResolvedValue({
      data: [{ accept: mockAccept, publicOrganizationData: { id: "org_xyz" } }],
    });

    render(<AcceptInvitePage />);

    await waitFor(() => expect(mockNavigateHard).toHaveBeenCalledWith("/apps"));
  });

  it("renders sign-in-with-different-account button on no-match error", async () => {
    mockTicket.mockResolvedValue({ error: clerkError("identifier_already_signed_in") });
    mockGetOrganizationInvitations.mockResolvedValue({
      data: [{ accept: vi.fn(), publicOrganizationData: { id: "org_other" } }],
    });

    const { getByRole, getByText } = render(<AcceptInvitePage />);

    await waitFor(() => expect(getByRole("alert")).toBeTruthy());
    expect(getByText(/Sign in with a different account/i)).toBeTruthy();
  });
});

// ── truly invalid ticket → shows error, does NOT navigate ─────────────────────

describe("truly invalid ticket → shows error, does NOT navigate (M-invalid)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows error for invitation_expired without navigating", async () => {
    mockTicket.mockResolvedValue({ error: clerkError("invitation_expired") });

    const { getByRole } = render(<AcceptInvitePage />);

    await waitFor(() => expect(getByRole("alert")).toBeTruthy());
    expect(getByRole("alert").textContent).toContain("expired");
    expect(mockNavigateHard).not.toHaveBeenCalled();
  });

  it("shows error for invitation_revoked without navigating", async () => {
    mockTicket.mockResolvedValue({ error: clerkError("invitation_revoked") });

    const { getByRole } = render(<AcceptInvitePage />);

    await waitFor(() => expect(getByRole("alert")).toBeTruthy());
    expect(getByRole("alert").textContent).toContain("revoked");
    expect(mockNavigateHard).not.toHaveBeenCalled();
  });
});
