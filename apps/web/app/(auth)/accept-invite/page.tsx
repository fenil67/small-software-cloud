"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSignIn, useSignUp, useClerk, useUser } from "@clerk/nextjs";
import { AuthCard } from "../../../components/auth/AuthCard";
import { navigateHard } from "../../../lib/navigate";

type PageState = "init" | "ready" | "accepting" | "wrong_account" | "done" | "error";

function ticketErrorMsg(code: string): string {
  if (code === "invitation_expired") return "This invitation has expired. Ask a workspace admin to resend it.";
  if (code === "invitation_revoked") return "This invitation was revoked. Contact your workspace admin.";
  if (code === "invitation_already_accepted") return "This invitation was already accepted.";
  if (code === "not_allowed_access") return "This invitation is not valid for your account.";
  if (code === "missing_requirements") return "Additional information is required to complete sign-up.";
  return "Could not accept the invitation. Please try again or contact your workspace admin.";
}

function extractCode(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const e = err as { errors?: Array<{ code?: string }> };
  return e.errors?.[0]?.code ?? "";
}

export default function AcceptInvitePage() {
  const params = useSearchParams();
  const ticket = params.get("__clerk_ticket") ?? params.get("__clerk_invitation_token") ?? "";
  const targetOrgId = params.get("org") ?? "";

  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const { setActive, signOut } = useClerk();
  const { user, isLoaded } = useUser();
  // Keep a ref so async callbacks always access the latest user object.
  // Updating a ref during render is intentional here: we want async callbacks
  // (checkMembership) to see the latest user value after setActive triggers a re-render,
  // without needing to re-invoke the callback.
  const userRef = useRef(user);
  // eslint-disable-next-line react-hooks/refs
  userRef.current = user;

  const [state, setState] = useState<PageState>("init");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [errorCode, setErrorCode] = useState<string>("");
  const [userEmail, setUserEmail] = useState<string>("");

  function showError(msg: string, code = "") {
    setErrorMsg(msg);
    setErrorCode(code);
    setState("error");
  }

  /**
   * Check whether the current user is a member of targetOrgId.
   * Activates the given session first so the user data reflects the new membership.
   * Uses userRef to pick up the latest user even if a re-render occurred after setActive.
   */
  async function checkMembership(sessionId: string | null): Promise<boolean> {
    if (!targetOrgId) return false;
    try {
      if (sessionId) await setActive({ session: sessionId });
    } catch {
      // setActive may fail if session is already active — still try to check below
    }
    // After setActive, pick up the freshest user reference
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
    if (!user) return;
    try {
      const { data: invitations } = await user.getOrganizationInvitations({ status: "pending" });
      const matching = invitations.find((inv) => inv.publicOrganizationData.id === targetOrgId);

      if (matching) {
        // Accept the matching invitation
        try {
          await matching.accept();
        } catch (err) {
          const code = extractCode(err);
          if (code !== "invitation_already_accepted" && code !== "already_a_member") {
            console.error("[accept-invite]", code);
            showError(ticketErrorMsg(code), code);
            return;
          }
          // already accepted/member — navigate anyway
        }
        setState("done");
        try {
          await setActive({ organization: targetOrgId });
        } catch { /* non-fatal */ }
        navigateHard("/apps");
        return;
      }

      // No pending invitation — check if already a member
      const { data: memberships } = await user.getOrganizationMemberships();
      const isMember = memberships.some((m) => m.organization.id === targetOrgId);
      if (isMember) {
        setState("done");
        try {
          await setActive({ organization: targetOrgId });
        } catch { /* non-fatal */ }
        navigateHard("/apps");
        return;
      }

      // Wrong account
      setUserEmail(user.primaryEmailAddress?.emailAddress ?? "");
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
        navigateHard("/apps");
      } else {
        const code = extractCode(error);
        console.error("[accept-invite]", code);
        showError(ticketErrorMsg(code), code);
      }
      return;
    }
    setState("done");
    try {
      await setActive({ session: sessionId ?? undefined, organization: targetOrgId || undefined });
    } catch { /* non-fatal */ }
    navigateHard("/apps");
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
    try {
      await setActive({ session: sessionId ?? undefined, organization: targetOrgId || undefined });
    } catch { /* non-fatal */ }
    navigateHard("/apps");
  }

  async function handleAccept() {
    if (!signIn || !signUp) return;
    setState("accepting");

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

  // Signed-in auto-detection
  useEffect(() => {
    if (!isLoaded) return;
    if (!ticket) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      showError("No invitation token found. This link may be invalid or expired.");
      return;
    }
    if (user) {
      void detectSignedInState();
    } else {
      setState("ready");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, ticket]);

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
          <button
            type="button"
            onClick={() => void signOut({ redirectUrl: window.location.href })}
            className="w-full rounded-xl bg-btn-bg px-4 py-2.5 text-sm font-semibold text-btn-fg transition-opacity hover:opacity-90"
          >
            Sign out and continue
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
