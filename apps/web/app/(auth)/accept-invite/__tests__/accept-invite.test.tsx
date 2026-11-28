/**
 * accept-invite/page.tsx — button-driven state machine tests.
 *
 * Key states:
 *   not signed in → shows "ready" state with Accept button
 *   signed in → auto-detects and processes (auto-fire)
 *
 * Root cause tests:
 *   - setActive called with both session + org (KEY FIX)
 *   - signed-in already-member navigates without accept()
 *   - detection runs at most once even with unstable object identities (loop fix)
 *   - wrong-account renders and stays (loop fix)
 *   - 15s timeout shows error state
 *
 * Mutation targets:
 *   M1: skip membership check in finishSignIn → M-not-member test fails
 *   M2: remove org-match filter in detectSignedInState → wrong invitation accepted
 *   M3 (loop): remove hasRun ref → detection runs multiple times
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";
import AcceptInvitePage from "../page";
import { useSearchParams } from "next/navigation";

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
  mockUseSession,
  mockUseClerk,
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
  mockUseSession: vi.fn(),
  mockUseClerk: vi.fn(),
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
  useClerk: mockUseClerk,
  useUser: mockUseUser,
  useSession: mockUseSession,
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
      id: "user_test_id",
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
  vi.useRealTimers();
  mockSetActive.mockResolvedValue(undefined);
  mockSignOut.mockResolvedValue(undefined);
  mockUserReload.mockResolvedValue(undefined);
  mockTicket.mockResolvedValue({ error: null });
  mockFinalize.mockResolvedValue({ error: null });
  mockSignUpTicket.mockResolvedValue({ error: null });
  mockSignUpFinalize.mockResolvedValue({ error: null });
  mockAccept.mockResolvedValue({});
  mockGetOrganizationInvitations.mockResolvedValue({ data: [] });
  mockGetOrganizationMemberships.mockResolvedValue({ data: [] });
  // Default useClerk: no signed-in sessions on the client
  mockUseClerk.mockReturnValue({
    setActive: mockSetActive,
    signOut: mockSignOut,
    client: { signedInSessions: [] },
  });
  // Default useSession: session with a known id
  mockUseSession.mockReturnValue({ isLoaded: true, isSignedIn: true, session: { id: "session_xyz" } });
  // Clear sessionStorage between tests so the storage guard doesn't interfere
  if (typeof sessionStorage !== "undefined") sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
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

// ── 5. Revoked ticket → shows "cancelled" message ────────────────────────────
// Tests the real Clerk error code (organization_invitation_revoked_code) that
// was shown as the generic fallback before this fix.

describe("revoked ticket → shows cancelled message (real Clerk error code)", () => {
  it("shows 'cancelled' message for organization_invitation_revoked_code", async () => {
    mockNotSignedIn();
    mockTicket.mockResolvedValue({ error: clerkError("organization_invitation_revoked_code") });

    render(<AcceptInvitePage />);
    const btn = await screen.findByRole("button", { name: /accept invitation/i });
    fireEvent.click(btn);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).toContain("cancelled");
    expect(screen.getByText(/organization_invitation_revoked_code/)).toBeInTheDocument();
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

// ── 11. Loop fix: detection runs once even when isLoaded toggles ─────────────
// Root cause: when setActive fires after detecting signed-in state, Clerk
// briefly sets isLoaded false→true, re-triggering the effect and re-running
// detection. The hasRun ref prevents re-entry.
// Mutation M3 (remove the hasRun check): this test must fail.

describe("loop fix: detection runs once even when isLoaded toggles false→true again", () => {
  it("getOrganizationInvitations called exactly once after isLoaded toggles", async () => {
    const mockAcceptInv = vi.fn().mockResolvedValue({});

    // Start: not loaded
    mockUseUser.mockReturnValue({ isLoaded: false, isSignedIn: false, user: null });
    mockGetOrganizationInvitations.mockResolvedValue({
      data: [{ accept: mockAcceptInv, publicOrganizationData: { id: "org_xyz" } }],
    });

    const { rerender } = render(<AcceptInvitePage />);

    // Clerk loads: signed in with matching invitation
    mockSignedIn();
    rerender(<AcceptInvitePage />);
    await waitFor(() => expect(mockNavigateHard).toHaveBeenCalledWith("/apps"));

    // Simulate Clerk toggling isLoaded false→true (happens after setActive)
    mockUseUser.mockReturnValue({ isLoaded: false, isSignedIn: false, user: null });
    rerender(<AcceptInvitePage />);

    mockSignedIn(); // back to signed-in
    rerender(<AcceptInvitePage />); // isLoaded true again — without guard would re-run detection

    // Detection must have run exactly once despite the isLoaded toggle
    expect(mockGetOrganizationInvitations).toHaveBeenCalledTimes(1);
    expect(mockNavigateHard).toHaveBeenCalledTimes(1);
  });
});

// ── 12. Loop fix: wrong-account renders immediately and stays ─────────────────

describe("loop fix: wrong-account renders and does not loop", () => {
  it("shows wrong_account card and stays there (navigateHard not called)", async () => {
    mockSignedIn();
    mockGetOrganizationInvitations.mockResolvedValue({ data: [] });
    mockGetOrganizationMemberships.mockResolvedValue({ data: [] });

    render(<AcceptInvitePage />);

    await waitFor(() => expect(screen.getByText(/signed in as/i)).toBeInTheDocument());

    // Detection should run exactly once — wrong-account does not trigger a loop
    expect(mockGetOrganizationInvitations).toHaveBeenCalledTimes(1);
    expect(mockNavigateHard).not.toHaveBeenCalled();
  });
});

// ── 13. 15-second timeout shows error state ───────────────────────────────────

describe("15-second timeout shows error state with code timeout", () => {
  it("shows error with code 'timeout' after 15 seconds in init state", async () => {
    // Signed in, but detection hangs indefinitely (promise never resolves)
    mockUseUser.mockReturnValue({ isLoaded: true, isSignedIn: true, user: {
      id: "u1",
      reload: mockUserReload,
      getOrganizationMemberships: mockGetOrganizationMemberships,
      getOrganizationInvitations: vi.fn(() => new Promise(() => { /* never resolves */ })),
      primaryEmailAddress: { emailAddress: "user@test.com" },
    }});

    vi.useFakeTimers();

    render(<AcceptInvitePage />);

    // Advance past the 15s timeout
    await act(async () => {
      vi.advanceTimersByTime(15001);
    });

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/timeout/i)).toBeInTheDocument();
    expect(mockNavigateHard).not.toHaveBeenCalled();
  });
});

// ── 14. URL-strip: history.replaceState strips ticket params on mount ──────────
// Root cause fix: without this, Clerk's router.refresh() after setActive
// re-fetches the current URL with the ticket, triggering the Clerk handshake
// redirect which breaks the RSC fetch (Safari loop).
// Mutation: comment out the history.replaceState useEffect → replaceState not called → test fails.

describe("URL-strip: ticket params removed from address bar on mount", () => {
  it("calls history.replaceState and the resulting path has no ticket params", async () => {
    // Spy before render so we capture the call
    const replaceState = vi.spyOn(history, "replaceState");
    mockNotSignedIn();

    render(<AcceptInvitePage />);

    // The mount effect must call replaceState (ticket is non-empty per useSearchParams mock)
    await waitFor(() => expect(replaceState).toHaveBeenCalled());

    // Every call must NOT include the sensitive params in the URL argument (3rd arg)
    for (const call of replaceState.mock.calls) {
      const url = String(call[2] ?? "");
      expect(url).not.toContain("__clerk_ticket");
      expect(url).not.toContain("__clerk_invitation_token");
      expect(url).not.toContain("__clerk_status");
    }

    replaceState.mockRestore();
  });
});

// ── 15. sessionStorage "done": reload → navigate without calling Clerk ─────────
// If the ticket was already processed successfully (e.g. from a prior load),
// the page should navigate directly to /apps without re-running any Clerk calls.
// Mutation: remove the ssGet "done" check in the detection effect → Clerk is called → test fails.

describe("sessionStorage done: reload navigates without calling Clerk", () => {
  it("navigates to /apps without calling any Clerk API when sessionStorage has 'done'", async () => {
    mockNotSignedIn();

    // Pre-seed sessionStorage as if this ticket was already successfully processed
    sessionStorage.setItem("accept-invite-v1:ticket_abc", "done");

    render(<AcceptInvitePage />);

    await waitFor(() => expect(mockNavigateHard).toHaveBeenCalledWith("/apps"));

    // No Clerk ticket or invitation calls should be made
    expect(mockTicket).not.toHaveBeenCalled();
    expect(mockGetOrganizationInvitations).not.toHaveBeenCalled();
  });
});

// ── 16. sessionStorage error: reload → shows error without calling Clerk ───────
// If this ticket previously failed, show the same error immediately on reload
// without re-attempting the Clerk API (prevents hammering an expired ticket).
// Mutation: remove the ssGet "error:" check in the detection effect → Clerk is called → test fails.

describe("sessionStorage error: reload shows error without calling Clerk", () => {
  it("shows error state without calling Clerk when sessionStorage has an error record", async () => {
    mockNotSignedIn();

    // Pre-seed sessionStorage with a prior failure for this ticket
    sessionStorage.setItem("accept-invite-v1:ticket_abc", "error:invitation_expired");

    render(<AcceptInvitePage />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).toContain("expired");

    // No Clerk calls made
    expect(mockTicket).not.toHaveBeenCalled();
    expect(mockGetOrganizationInvitations).not.toHaveBeenCalled();
    expect(mockNavigateHard).not.toHaveBeenCalled();
  });
});

// ── 17. Expired ticket (ticket_expired_code) → shows "expired" message ────────

describe("expired ticket → shows expired message (ticket_expired_code)", () => {
  it("shows 'expired' message for ticket_expired_code", async () => {
    mockNotSignedIn();
    mockTicket.mockResolvedValue({ error: clerkError("ticket_expired_code") });

    render(<AcceptInvitePage />);
    const btn = await screen.findByRole("button", { name: /accept invitation/i });
    fireEvent.click(btn);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).toContain("expired");
    expect(screen.getByText(/ticket_expired_code/)).toBeInTheDocument();
  });
});

// ── 18. Already-used ticket → shows "already used" with sign-in link ──────────

describe("already-used ticket → shows already-used message", () => {
  it("shows 'already used' message for invitation_already_accepted", async () => {
    mockNotSignedIn();
    mockTicket.mockResolvedValue({ error: clerkError("invitation_already_accepted") });

    render(<AcceptInvitePage />);
    const btn = await screen.findByRole("button", { name: /accept invitation/i });
    fireEvent.click(btn);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).toContain("already used");
    // Sign-in link present in error state
    expect(screen.getByRole("link", { name: /sign-in/i })).toBeInTheDocument();
  });

  it("shows 'already used' message for already_a_member_in_organization", async () => {
    mockNotSignedIn();
    mockTicket.mockResolvedValue({ error: clerkError("already_a_member_in_organization") });

    render(<AcceptInvitePage />);
    const btn = await screen.findByRole("button", { name: /accept invitation/i });
    fireEvent.click(btn);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).toContain("already used");
  });
});

// ── 19. Invalid ticket (ticket_invalid_code) → shows "not valid" message ──────

describe("invalid ticket → shows not-valid message (ticket_invalid_code)", () => {
  it("shows 'not valid' message for ticket_invalid_code", async () => {
    mockNotSignedIn();
    mockTicket.mockResolvedValue({ error: clerkError("ticket_invalid_code") });

    render(<AcceptInvitePage />);
    const btn = await screen.findByRole("button", { name: /accept invitation/i });
    fireEvent.click(btn);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).toContain("not valid");
    expect(screen.getByText(/ticket_invalid_code/)).toBeInTheDocument();
  });
});

// ── 20. Unknown error code → shows generic message ────────────────────────────

describe("unknown error code → shows generic fallback message", () => {
  it("shows generic 'Could not accept' message for unknown codes", async () => {
    mockNotSignedIn();
    mockTicket.mockResolvedValue({ error: clerkError("some_unknown_clerk_code_xyz") });

    render(<AcceptInvitePage />);
    const btn = await screen.findByRole("button", { name: /accept invitation/i });
    fireEvent.click(btn);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).toContain("Could not accept the invitation");
  });
});

// ── 21. Mutation: map revoked to generic → test 5 fails ───────────────────────
// .bak mutation proof: if organization_invitation_revoked_code maps to the generic
// message instead of "cancelled", test 5 would fail (it checks for "cancelled").
// This test documents the guard by verifying the fix is in place.
// Run with the .bak method: copy page.tsx → page.tsx.bak, mutate line
//   "organization_invitation_revoked_code" ... → return generic message,
//   run suite (test 5 must fail), restore from .bak.

describe("code-mapping guard: organization_invitation_revoked_code maps to 'cancelled', not generic", () => {
  it("revoked code message contains 'cancelled' (would fail if mapped to generic)", async () => {
    mockNotSignedIn();
    mockTicket.mockResolvedValue({ error: clerkError("organization_invitation_revoked_code") });

    render(<AcceptInvitePage />);
    const btn = await screen.findByRole("button", { name: /accept invitation/i });
    fireEvent.click(btn);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    // This would fail if the mapping returned the generic message
    expect(screen.getByRole("alert").textContent).not.toContain("Could not accept");
    expect(screen.getByRole("alert").textContent).toContain("cancelled");
  });
});

// ── 22. Wrong account: sign-out calls signOut with sessionId + ticket in URL ───
// ROOT CAUSE FIX: previously signOut used redirectUrl: window.location.href
// (stripped of ticket) → page reloaded with no ticket → error. Now we pass
// sessionId to sign out only the active session, and include the ticket in the
// redirectUrl so the signed-out Accept flow can proceed.

describe("wrong account: sign-out button calls signOut with sessionId and ticket in redirectUrl", () => {
  it("calls signOut({ sessionId, redirectUrl }) with ticket and org in redirectUrl", async () => {
    mockSignedIn();
    mockGetOrganizationInvitations.mockResolvedValue({ data: [] });
    mockGetOrganizationMemberships.mockResolvedValue({ data: [] });
    // Session with a known id
    mockUseSession.mockReturnValue({ isLoaded: true, isSignedIn: true, session: { id: "session_xyz" } });

    render(<AcceptInvitePage />);
    const signOutBtn = await screen.findByRole("button", { name: /sign out and continue/i });
    fireEvent.click(signOutBtn);

    await waitFor(() =>
      expect(mockSignOut).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session_xyz",
          redirectUrl: expect.stringContaining("__clerk_ticket=ticket_abc"),
        }),
      ),
    );
    expect(mockSignOut).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUrl: expect.stringContaining("org=org_xyz") }),
    );
    // Should NOT redirect to /apps — that's left to the next page load
    expect(mockNavigateHard).not.toHaveBeenCalled();
  });
});

// ── 23. Missing ticket → shows friendly "open the link" message ───────────────
// When the page is opened without a ticket (e.g. user typed /accept-invite
// directly), the error should say "Open the link from your invitation email".

describe("missing ticket → shows friendly open-link message", () => {
  it("shows 'Open the link' message when no ticket in URL", async () => {
    // Override useSearchParams to return no ticket
    vi.mocked(useSearchParams).mockReturnValueOnce({
      get: (k: string) => {
        if (k === "org") return "org_xyz";
        return null;
      },
    } as ReturnType<typeof useSearchParams>);
    mockNotSignedIn();

    render(<AcceptInvitePage />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).toContain("Open the link from your invitation email");
  });
});

// ── 24. Multi-session guard: signed-in sessions prevent ticket sign-in ─────────
// If clerkClient.signedInSessions is non-empty but no active user (e.g. during
// session switching), clicking Accept must show the Wrong account card, NOT call
// signIn.ticket(). Without this guard a ticket sign-in would silently add a
// second session.
// Mutation M-wa: comment out the guard → signIn.ticket() IS called → test fails.

describe("multi-session guard: existing sessions show wrong_account before ticket sign-in", () => {
  it("shows wrong_account card and does not call ticket() when signedInSessions exist", async () => {
    // No active user (Clerk shows user as null mid-session-switch)
    mockNotSignedIn();
    // But a signed-in session exists on the client
    mockUseClerk.mockReturnValue({
      setActive: mockSetActive,
      signOut: mockSignOut,
      client: {
        signedInSessions: [{ id: "session_other", publicUserData: { identifier: "other@test.com" } }],
      },
    });

    render(<AcceptInvitePage />);
    const btn = await screen.findByRole("button", { name: /accept invitation/i });
    fireEvent.click(btn);

    // Wrong account card must appear
    await waitFor(() => expect(screen.getByText(/signed in as/i)).toBeInTheDocument());
    // ticket() must NEVER be called — that would have silently added a session
    expect(mockTicket).not.toHaveBeenCalled();
  });
});
