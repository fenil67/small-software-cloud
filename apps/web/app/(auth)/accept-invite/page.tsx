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
  // __clerk_status=complete means FAPI already processed a used invitation ticket.
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

  function showError(msg: string, code = "") {
    setErrorMsg(msg);
    setErrorCode(code);
    setState("error");
    // Record failure in sessionStorage so a reload doesn't re-run the ticket.
    if (ticket) ssSet(SS_PREFIX + ticket, `error:${code}`);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Checks org membership with paging. Caps at 20 pages (1 000 memberships). */
  async function isMemberOf(u: NonNullable<typeof user>, orgId: string): Promise<boolean> {
    const PAGE_SIZE = 50;
    for (let page = 1; page <= 20; page++) {
      const { data, total_count } = await u.getOrganizationMemberships({ pageSize: PAGE_SIZE, initialPage: page });
      if (data.some((m: { organization: { id: string } }) => m.organization.id === orgId)) return true;
      if (data.length < PAGE_SIZE || page * PAGE_SIZE >= total_count) return false;
    }
    return false;
  }

  /**
   * Polls for the target org membership to appear in Clerk (backend propagation
   * can take several seconds after ticket acceptance), then switches active org
   * and navigates to /apps.
   *
   * - sessionId non-null: called from finishSignIn/finishSignUp (new sign-in).
   *   Activates the session first; if the user ref isn't available yet (Clerk
   *   hasn't re-rendered React), falls back to the combined setActive call so
   *   the user at least lands somewhere rather than seeing an error.
   *
   * - sessionId null: called from detectSignedInState/stored-done (already
   *   signed in). The user ref is available, so full membership polling runs.
   *
   * On unrecoverable failure (membership never appears, setActive rejects)
   * shows an error and does NOT navigate.
   */
  async function activateAndNavigate(sessionId: string | null) {
    if (sessionId) {
      try { await setActive({ session: sessionId }); } catch { /* may already be active */ }
    }

    if (!targetOrgId) {
      setState("done");
      ssSet(SS_PREFIX + ticket, "done");
      safeNavigate("/apps");
      return;
    }

    const currentUser = userRef.current;
    if (!currentUser) {
      // User ref not yet populated (React hasn't re-rendered after setActive).
      // Fall back: attempt the combined call so the user at least lands with the
      // new session active. The invited workspace may not switch on this attempt,
      // but it's better than showing an error.
      if (sessionId) {
        try { await setActive({ session: sessionId, organization: targetOrgId }); } catch {}
      }
      setState("done");
      ssSet(SS_PREFIX + ticket, "done");
      safeNavigate("/apps");
      return;
    }

    // Poll for membership to become visible (Clerk backend propagation delay)
    const delays = [500, 1000, 1500, 2000, 2000]; // up to ~7 s total
    let found = false;
    for (let i = 0; i <= delays.length; i++) {
      if (i > 0) await sleep(delays[i - 1]);
      try {
        await currentUser.reload();
        found = await isMemberOf(currentUser, targetOrgId);
        if (found) break;
      } catch { /* transient error — keep polling */ }
    }

    if (!found) {
      showError("You've joined the workspace, but we couldn't open it. Refresh to try again.");
      return;
    }

    try {
      await setActive({ organization: targetOrgId });
    } catch {
      showError("You've joined the workspace, but we couldn't open it. Refresh to try again.");
      return;
    }

    setState("done");
    ssSet(SS_PREFIX + ticket, "done");
    safeNavigate("/apps");
  }

  // Strip ticket/org params from the address bar immediately on mount — BEFORE
  // any async work. This ensures that when Clerk's ClerkProvider calls
  // router.refresh() after setActive, the RSC re-fetch sees a clean URL and
  // does not trigger the Clerk handshake redirect loop.
  useEffect(() => {
    if (!ticket) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("__clerk_ticket");
    url.searchParams.delete("__clerk_invitation_token");
    url.searchParams.delete("__clerk_status");
    url.searchParams.delete("org");
    // Use pathname+search (relative) so this is safe in all environments.
    history.replaceState(null, "", url.pathname + url.search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // Poll until new membership propagates to Clerk, then switch active org.
        await activateAndNavigate(null);
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
        safeNavigate("/apps");
      } else {
        const code = extractCode(error);
        console.error("[accept-invite]", code);
        showError(ticketErrorMsg(code), code);
      }
      return;
    }
    // Poll until new membership propagates to Clerk, then switch active org.
    await activateAndNavigate(sessionId);
  }

  async function finishSignUp(sessionId: string | null) {
    const { error } = await signUp!.finalize();
    if (error) {
      const code = extractCode(error);
      console.error("[accept-invite]", code);
      showError(ticketErrorMsg(code), code);
      return;
    }
    // Poll until new membership propagates to Clerk, then switch active org.
    await activateAndNavigate(sessionId);
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
      // __clerk_status=complete means FAPI processed a used invitation ticket and
      // stripped __clerk_ticket before redirecting. Any other empty-ticket visit is
      // a direct navigation without an invite link.
      if (clerkStatus === "complete") {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setState("used_invitation");
      } else {
        showError("Open the link from your invitation email again.");
      }
      return;
    }

    // sessionStorage guard: if we already processed this ticket, skip re-running.
    // Covers: (1) page reload after navigateHard, (2) Clerk RSC re-fetch causing
    // a full reload before the new page has loaded.
    const stored = ssGet(SS_PREFIX + ticket);
    if (stored === "done") {
      // If the user is still signed in and targetOrgId is known, verify they are
      // still a member before navigating — they may have left since the last visit.
      if (userId && targetOrgId) {
        void (async () => {
          const u = userRef.current;
          if (!u) { safeNavigate("/apps"); return; }
          try {
            await u.reload();
            const member = await isMemberOf(u, targetOrgId);
            if (member) {
              void activateAndNavigate(null);
            } else {
              setState("used_invitation");
            }
          } catch {
            safeNavigate("/apps"); // fall back on error
          }
        })();
      } else {
        safeNavigate("/apps");
      }
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

  if (state === "used_invitation") {
    return (
      <AuthCard title="Invitation already used" subtitle="">
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-2)", textAlign: "center" }}>
            This invitation has already been used. If you left or were removed from the workspace, ask an admin to send you a new invitation.
          </p>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-3)", textAlign: "center" }}>
            {userId ? (
              /* eslint-disable-next-line @next/next/no-html-link-for-pages */
              <a href="/apps" style={{ color: "var(--fg)", textDecoration: "underline" }}>Go to my apps</a>
            ) : (
              <a href="/sign-in" style={{ color: "var(--fg)", textDecoration: "underline" }}>Go to sign-in</a>
            )}
          </p>
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
