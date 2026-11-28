"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSignIn, useSignUp, useClerk, useUser, useSession } from "@clerk/nextjs";
import { AuthCard } from "../../../components/auth/AuthCard";
import { navigateHard } from "../../../lib/navigate";

type PageState = "init" | "ready" | "accepting" | "wrong_account" | "done" | "error" | "used_invitation";

const SS_PREFIX = "accept-invite-v1:";

function ticketErrorMsg(code: string): string {
  // Codes verified in @clerk/shared localization types and user bug report.
  if (code === "organization_invitation_revoked_code" || code === "invitation_revoked")
    return "This invitation was cancelled. Ask the workspace admin to send a new one.";
  if (code === "ticket_expired_code" || code === "invitation_expired")
    return "This invitation has expired. Ask the workspace admin to send a new one.";
  if (
    code === "invitation_already_accepted" ||
    code === "already_a_member_in_organization" ||
    code === "already_a_member"
  ) return "This invitation was already used. Sign in to continue.";
  if (code === "ticket_invalid_code") return "This invitation link is not valid.";
  if (code === "not_allowed_access") return "This invitation is not valid for your account.";
  if (code === "missing_requirements") return "Additional information is required to complete sign-up.";
  if (code === "timeout") return "The request timed out. Please try again or contact your workspace admin.";
  return "Could not accept the invitation. Please try again or contact your workspace admin.";
}

function extractCode(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const e = err as { errors?: Array<{ code?: string }> };
  return e.errors?.[0]?.code ?? "";
}

function ssGet(key: string): string | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function ssSet(key: string, value: string): void {
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(key, value);
  } catch { /* private browsing */ }
}

export default function AcceptInvitePage() {
  const params = useSearchParams();
  // Read once from searchParams. history.replaceState (called on mount) does
  // not trigger a Next.js router update, so these values remain stable.
  // Even if they became empty, hasRun.current prevents the effect from re-running.
  const ticket = params.get("__clerk_ticket") ?? params.get("__clerk_invitation_token") ?? "";
  const targetOrgId = params.get("org") ?? "";
  // __clerk_status is set by FAPI when redirecting back after processing a ticket.
  // Any non-empty value means the invitation flow came through FAPI (used ticket path).
  const clerkStatus = params.get("__clerk_status") ?? "";

  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const { setActive, signOut, client: clerkClient } = useClerk();
  const { user, isLoaded } = useUser();
  const { session } = useSession();
  // Stable ref to latest user — read inside async callbacks to avoid stale closures.
  const userRef = useRef(user);
  // eslint-disable-next-line react-hooks/refs
  userRef.current = user;

  const [state, setState] = useState<PageState>("init");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [errorCode, setErrorCode] = useState<string>("");
  const [userEmail, setUserEmail] = useState<string>("");
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");

  // Run-once guard: prevents the detection effect from firing again if Clerk
  // briefly toggles isLoaded false→true after setActive (which would loop).
  const hasRun = useRef(false);

  // Navigate-once guard: prevents double navigation from async races.
  const navigated = useRef(false);

  function safeNavigate(path: string) {
    if (navigated.current) return;
    navigated.current = true;
    navigateHard(path);
  }

  // Navigation destination for accept flows: include ?org= so DashboardShell
  // can verify the org is active after a new session is established.
  function appsDestination(): string {
    return targetOrgId ? `/apps?org=${encodeURIComponent(targetOrgId)}` : "/apps";
  }

  function showError(msg: string, code = "") {
    setErrorMsg(msg);
    setErrorCode(code);
    setState("error");
    // Record failure in sessionStorage so a reload doesn't re-run the ticket.
    if (ticket) ssSet(SS_PREFIX + ticket, `error:${code}`);
  }

  /**
   * Check org membership with paging. Single sweep — no polling, no reload.
   * Uses ClerkPaginationParams (pageSize/initialPage) and ClerkPaginatedResponse (total_count).
   */
  async function isMemberOfPaged(u: NonNullable<typeof user>, orgId: string): Promise<boolean> {
    const PAGE_SIZE = 50;
    for (let page = 1; page <= 20; page++) {
      const { data, total_count } = await u.getOrganizationMemberships({ pageSize: PAGE_SIZE, initialPage: page });
      if (data.some((m: { organization: { id: string } }) => m.organization.id === orgId)) return true;
      if (data.length < PAGE_SIZE || page * PAGE_SIZE >= total_count) return false;
    }
    return false;
  }

  // Strip all invite-related params from the address bar immediately on mount —
  // BEFORE any async work. ticket, targetOrgId, and clerkStatus are captured
  // above from useSearchParams() at render time and remain valid after the strip.
  // Strip runs unconditionally so it also covers the __clerk_status-only path
  // (used-link redirect), where router.refresh() after setActive would
  // otherwise find params still in the router state and re-trigger the branch.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("__clerk_ticket");
    url.searchParams.delete("__clerk_invitation_token");
    url.searchParams.delete("__clerk_status");
    url.searchParams.delete("org");
    history.replaceState(null, "", url.pathname + url.search);
  }, []);

  // 15-second hard timeout: if still in a pending state, show error.
  useEffect(() => {
    const timer = setTimeout(() => {
      setState((s) => {
        if (s === "init" || s === "accepting") {
          setErrorMsg(ticketErrorMsg("timeout"));
          setErrorCode("timeout");
          if (ticket) ssSet(SS_PREFIX + ticket, "error:timeout");
          return "error";
        }
        return s;
      });
    }, 15000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Check whether the current user is a member of targetOrgId.
   * Uses userRef to pick up the latest user even if a re-render occurred after setActive.
   */
  async function checkMembership(sessionId: string | null): Promise<boolean> {
    if (!targetOrgId) return false;
    try {
      if (sessionId) await setActive({ session: sessionId });
    } catch {
      // setActive may fail if session is already active — still try to check below
    }
    const currentUser = userRef.current;
    if (!currentUser) return false;
    try {
      await currentUser.reload();
      const { data: memberships } = await currentUser.getOrganizationMemberships();
      return memberships.some((m) => m.organization.id === targetOrgId);
    } catch {
      return false;
    }
  }

  async function detectSignedInState() {
    const currentUser = userRef.current;
    if (!currentUser) return;
    try {
      const { data: invitations } = await currentUser.getOrganizationInvitations({ status: "pending" });
      const matching = invitations.find((inv) => inv.publicOrganizationData.id === targetOrgId);

      if (matching) {
        try {
          await matching.accept();
        } catch (err) {
          const code = extractCode(err);
          if (code !== "invitation_already_accepted" && code !== "already_a_member" && code !== "already_a_member_in_organization") {
            console.error("[accept-invite]", code);
            showError(ticketErrorMsg(code), code);
            return;
          }
        }
        setState("done");
        ssSet(SS_PREFIX + ticket, "done");
        try {
          await setActive({ organization: targetOrgId });
        } catch { /* non-fatal */ }
        safeNavigate("/apps");
        return;
      }

      // No pending invitation — check if already a member
      const { data: memberships } = await currentUser.getOrganizationMemberships();
      const isMember = memberships.some((m) => m.organization.id === targetOrgId);
      if (isMember) {
        setState("done");
        ssSet(SS_PREFIX + ticket, "done");
        try {
          await setActive({ organization: targetOrgId });
        } catch { /* non-fatal */ }
        safeNavigate("/apps");
        return;
      }

      // Wrong account — show card immediately, do not loop
      setUserEmail(currentUser.primaryEmailAddress?.emailAddress ?? "");
      setState("wrong_account");
    } catch {
      showError(ticketErrorMsg(""), "");
    }
  }

  async function finishSignIn(sessionId: string | null) {
    const { error } = await signIn!.finalize();
    if (error) {
      const isMember = await checkMembership(sessionId);
      if (isMember) {
        setState("done");
        ssSet(SS_PREFIX + ticket, "done");
        safeNavigate(appsDestination());
      } else {
        const code = extractCode(error);
        console.error("[accept-invite]", code);
        showError(ticketErrorMsg(code), code);
      }
      return;
    }
    setState("done");
    ssSet(SS_PREFIX + ticket, "done");
    // setActive is called ONLY here and in finishSignUp — the two ticket-based flows.
    // The __clerk_status (used-link) path does NOT call setActive to avoid triggering
    // Clerk's router.refresh() loop on the accept-invite page.
    try {
      await setActive({ session: sessionId ?? undefined, organization: targetOrgId || undefined });
    } catch { /* non-fatal */ }
    safeNavigate(appsDestination());
  }

  async function finishSignUp(sessionId: string | null) {
    const { error } = await signUp!.finalize();
    if (error) {
      const code = extractCode(error);
      console.error("[accept-invite]", code);
      showError(ticketErrorMsg(code), code);
      return;
    }
    setState("done");
    ssSet(SS_PREFIX + ticket, "done");
    try {
      await setActive({ session: sessionId ?? undefined, organization: targetOrgId || undefined });
    } catch { /* non-fatal */ }
    safeNavigate(appsDestination());
  }

  /**
   * Signs out only the active session, then navigates back to this page with
   * the ticket in the URL so the signed-out Accept flow can proceed.
   *
   * We call navigateHard ourselves rather than relying on Clerk's redirectUrl,
   * because Clerk's internal navigation does not reliably fire in this app
   * (same issue as setActive with navigateHard documented in CLAUDE.md).
   *
   * ticket is read from the in-memory value captured at initial render (before
   * history.replaceState stripped it from the URL), so it is always available
   * here even though the address bar no longer shows it.
   */
  async function handleSignOutAndContinue() {
    if (!ticket) {
      showError("Open the link from your invitation email again.");
      return;
    }
    setSigningOut(true);
    setSignOutError("");
    try {
      await signOut({ sessionId: session?.id });
    } catch {
      setSigningOut(false);
      setSignOutError("Could not sign out. Please try again.");
      return;
    }
    const qs = `__clerk_ticket=${encodeURIComponent(ticket)}${targetOrgId ? `&org=${encodeURIComponent(targetOrgId)}` : ""}`;
    navigateHard(`/accept-invite?${qs}`);
  }

  async function handleAccept() {
    if (!signIn || !signUp) return;
    setState("accepting");

    // Multi-session guard: if any signed-in sessions exist on this client but
    // no active user is set (e.g. mid-session-switch), do not proceed with the
    // ticket sign-in — it would silently add a second session. Show the Wrong
    // account card for the first existing session instead.
    const signedInSessions = clerkClient?.signedInSessions ?? [];
    if (signedInSessions.length > 0) {
      setUserEmail(signedInSessions[0].publicUserData.identifier);
      setState("wrong_account");
      return;
    }

    const { error: siError } = await signIn.ticket({ ticket });

    if (!siError && signIn.status === "complete") {
      await finishSignIn(signIn.createdSessionId);
      return;
    }

    const siCode = extractCode(siError);

    if (siCode === "identifier_already_signed_in") {
      await detectSignedInState();
      return;
    }

    if (siError && siCode !== "external_account_not_found") {
      console.error("[accept-invite]", siCode);
      showError(ticketErrorMsg(siCode), siCode);
      return;
    }

    // Try sign-up path
    const { error: suError } = await signUp.ticket({ ticket });
    if (suError) {
      const suCode = extractCode(suError);
      console.error("[accept-invite]", suCode);
      showError(ticketErrorMsg(suCode), suCode);
      return;
    }
    if (signUp.status === "complete") {
      await finishSignUp(signUp.createdSessionId);
    } else if (signUp.status === "missing_requirements") {
      showError(ticketErrorMsg("missing_requirements"), "missing_requirements");
    } else {
      showError(ticketErrorMsg(""), "");
    }
  }

  // Effect deps are stable primitives only (user?.id, isLoaded, ticket, targetOrgId).
  // Using user?.id instead of user object prevents re-firing when Clerk returns
  // a new object identity for the same user after setActive.
  // hasRun ref ensures detection runs at most once per page load even if
  // isLoaded briefly toggles false→true after setActive.
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!isLoaded) return;
    if (hasRun.current) return;
    hasRun.current = true;

    if (!ticket) {
      if (!clerkStatus) {
        // No ticket and no __clerk_status: direct navigation without an invite link.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        showError("Open the link from your invitation email again.");
        return;
      }
      // __clerk_status present (any value): arrived via FAPI from a used invitation link.
      // Check if the signed-in user is already a member of the target org.
      if (!userId) {
        // Not signed in — show used-invitation card with sign-in link.
        setState("used_invitation");
        return;
      }
      // Signed in — check membership once (single sweep, no polling, no reload).
      void (async () => {
        const currentUser = userRef.current;
        if (!currentUser) {
          setState("used_invitation");
          return;
        }
        try {
          const isMember = targetOrgId ? await isMemberOfPaged(currentUser, targetOrgId) : false;
          if (isMember) {
            // Do NOT call setActive here: setActive triggers Clerk's router.refresh(),
            // which can unmount/remount this page before navigateHard fires, restarting
            // the loop. DashboardShell handles the org switch at /apps?org=.
            setState("done");
            safeNavigate(appsDestination());
          } else {
            setState("used_invitation");
          }
        } catch {
          setState("used_invitation");
        }
      })();
      return;
    }

    // sessionStorage guard: if we already processed this ticket, skip re-running.
    // Covers: (1) page reload after navigateHard, (2) Clerk RSC re-fetch causing
    // a full reload before the new page has loaded.
    const stored = ssGet(SS_PREFIX + ticket);
    if (stored === "done") {
      safeNavigate(appsDestination());
      return;
    }
    if (stored?.startsWith("error:")) {
      const code = stored.slice(6);
      showError(ticketErrorMsg(code), code);
      return;
    }

    if (userId) {
      void detectSignedInState();
    } else {
      setState("ready");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, userId, ticket, targetOrgId]);

  if (state === "init") {
    return (
      <AuthCard title="Joining workspace" subtitle="Just a moment…">
        <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-3)", textAlign: "center" }}>
          Checking invitation…
        </p>
      </AuthCard>
    );
  }

  if (state === "ready") {
    return (
      <AuthCard title="You've been invited" subtitle="Join a workspace on Utir.">
        <button
          type="button"
          onClick={() => void handleAccept()}
          disabled={state !== "ready"}
          className="mt-4 w-full rounded-xl bg-btn-bg px-4 py-2.5 text-sm font-semibold text-btn-fg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Accept invitation
        </button>
      </AuthCard>
    );
  }

  if (state === "accepting") {
    return (
      <AuthCard title="Joining workspace" subtitle="Just a moment…">
        <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-3)", textAlign: "center" }}>
          Accepting invitation…
        </p>
      </AuthCard>
    );
  }

  if (state === "done") {
    return (
      <AuthCard title="Joining workspace" subtitle="">
        <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-3)", textAlign: "center" }}>
          Invitation accepted. Redirecting…
        </p>
      </AuthCard>
    );
  }

  if (state === "used_invitation") {
    return (
      <AuthCard title="Invitation already used" subtitle="">
        <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-2)", textAlign: "center", marginBottom: "16px" }}>
          This invitation has already been used. If you left or were removed from the workspace,
          ask an admin to send you a new invitation.
        </p>
        <a
          href={userId ? "/apps" : "/sign-in"}
          className="w-full rounded-xl bg-surface-2 px-4 py-2.5 text-sm font-semibold text-fg transition-opacity hover:opacity-90 text-center block"
        >
          {userId ? "Go to my apps" : "Sign in"}
        </a>
      </AuthCard>
    );
  }

  if (state === "wrong_account") {
    return (
      <AuthCard title="Wrong account" subtitle="">
        <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-2)", textAlign: "center", marginBottom: "16px" }}>
          This invitation is for another account. You&apos;re signed in as {userEmail}.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {signOutError && (
            <p role="alert" style={{ margin: 0, fontSize: "13px", color: "var(--red)", textAlign: "center" }}>
              {signOutError}
            </p>
          )}
          <button
            type="button"
            onClick={() => void handleSignOutAndContinue()}
            disabled={signingOut}
            className="w-full rounded-xl bg-btn-bg px-4 py-2.5 text-sm font-semibold text-btn-fg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {signingOut ? "Signing out\u2026" : "Sign out and continue"}
          </button>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/apps"
            className="w-full rounded-xl bg-surface-2 px-4 py-2.5 text-sm font-semibold text-fg transition-opacity hover:opacity-90 text-center block"
          >
            Go to my apps
          </a>
        </div>
      </AuthCard>
    );
  }

  // error state
  return (
    <AuthCard title="Joining workspace" subtitle="">
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <p role="alert" style={{ margin: 0, fontSize: "13px", color: "var(--red)", textAlign: "center" }}>
          {errorMsg}
        </p>
        {errorCode && (
          <p style={{ margin: 0, fontSize: "12px", color: "var(--fg-3)", textAlign: "center" }}>
            Error code: <code>{errorCode}</code>
          </p>
        )}
        <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-3)", textAlign: "center" }}>
          <a href="/sign-in" style={{ color: "var(--fg)", textDecoration: "underline" }}>
            Go to sign-in
          </a>
        </p>
      </div>
    </AuthCard>
  );
}
