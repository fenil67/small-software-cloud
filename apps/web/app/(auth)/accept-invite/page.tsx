"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSignIn, useSignUp, useClerk, useUser } from "@clerk/nextjs";
import { AuthCard } from "../../../components/auth/AuthCard";
import { navigateHard } from "../../../lib/navigate";

type Step = "loading" | "done" | "error";

function ticketError(err: unknown): string {
  if (typeof err !== "object" || err === null) return "Something went wrong. Please try again.";
  const e = err as { errors?: Array<{ code?: string }> };
  const code = e.errors?.[0]?.code ?? "";
  if (code === "invitation_expired") return "This invitation has expired. Ask a workspace admin to resend it.";
  if (code === "invitation_revoked") return "This invitation was revoked. Contact your workspace admin.";
  if (code === "invitation_already_accepted") return "This invitation was already accepted.";
  if (code === "not_allowed_access") return "This invitation is not valid for your account.";
  return "Could not accept the invitation. Please try again or contact your workspace admin.";
}

export default function AcceptInvitePage() {
  const params = useSearchParams();
  const ticket = params.get("__clerk_ticket") ?? params.get("__clerk_invitation_token") ?? "";
  // Target org Clerk ID embedded in the invitation link by the API
  const targetOrgId = params.get("org") ?? "";

  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const { setActive, signOut } = useClerk();
  const { user } = useUser();

  const [step, setStep] = useState<Step>("loading");
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [showSignOutLink, setShowSignOutLink] = useState(false);

  /**
   * Check whether the current user is a member of targetOrgId.
   * Activates the given session first so the user data reflects the new membership.
   */
  async function checkMembership(sessionId: string | null): Promise<boolean> {
    if (!targetOrgId || !user) return false;
    try {
      if (sessionId) await setActive({ session: sessionId });
    } catch {
      // setActive may fail if session is already active — still try to check below
    }
    try {
      await user.reload();
      const { data: memberships } = await user.getOrganizationMemberships();
      return memberships.some((m) => m.organization.id === targetOrgId);
    } catch {
      return false;
    }
  }

  async function accept() {
    // Try sign-in first (existing Clerk account)
    const { error: siError } = await signIn.ticket({ ticket });

    if (!siError && signIn.status === "complete") {
      await finishSignIn(signIn.createdSessionId);
      return;
    }

    const siCode = (siError as { errors?: Array<{ code?: string }> } | null)?.errors?.[0]?.code ?? "";

    // User is already signed in — accept via their active session
    if (siCode === "identifier_already_signed_in") {
      await acceptAsSignedInUser();
      return;
    }

    if (siError && siCode !== "external_account_not_found") {
      // Real error — don't attempt sign-up
      setErrorMessage(ticketError(siError));
      setStep("error");
      return;
    }

    // Try sign-up (new user creating account via invitation)
    const { error: suError } = await signUp.ticket({ ticket });
    if (suError) {
      setErrorMessage(ticketError(suError));
      setStep("error");
      return;
    }
    if (signUp.status === "complete") {
      await finishSignUp(signUp.createdSessionId);
    } else {
      // Needs additional steps (name, etc.) — Clerk will redirect via redirectUrl
      // which is set to /accept-invite in the API. Fall through gracefully.
      setErrorMessage("Additional steps required. Please check your email for further instructions.");
      setStep("error");
    }
  }

  /**
   * User is already signed in. Find the pending org invitation whose org matches
   * the link, accept it, and navigate. If no matching invitation exists, the link
   * is for a different account — show an error so the user can switch.
   */
  async function acceptAsSignedInUser() {
    if (!user) {
      setErrorMessage("Could not accept the invitation. Please try again.");
      setStep("error");
      return;
    }
    try {
      const { data: invitations } = await user.getOrganizationInvitations({ status: "pending" });

      const matching = invitations.find(
        (inv) => inv.publicOrganizationData.id === targetOrgId,
      );

      if (!matching) {
        setShowSignOutLink(true);
        setErrorMessage("This invitation is not for this account.");
        setStep("error");
        return;
      }

      try {
        await matching.accept();
      } catch (err) {
        const code = (err as { errors?: Array<{ code?: string }> })?.errors?.[0]?.code ?? "";
        if (code !== "invitation_already_accepted" && code !== "already_a_member") {
          setErrorMessage(ticketError(err));
          setStep("error");
          return;
        }
        // invitation_already_accepted or already_a_member: membership exists — navigate
      }

      setStep("done");
      try {
        await setActive({ organization: matching.publicOrganizationData.id });
      } catch { /* setActive failure is non-fatal */ }
      navigateHard("/apps");
    } catch {
      setErrorMessage("Could not accept the invitation. Please try again.");
      setStep("error");
    }
  }

  async function finishSignIn(sessionId: string | null) {
    const { error } = await signIn.finalize();
    if (error) {
      // ticket() completed — the org membership may already exist.
      // Only navigate if the user is confirmed to be a member of the invited org.
      const isMember = await checkMembership(sessionId);
      if (isMember) {
        setStep("done");
        navigateHard("/apps");
      } else {
        setErrorMessage(ticketError(error));
        setStep("error");
      }
      return;
    }
    await activateAndNavigate(sessionId);
  }

  async function finishSignUp(sessionId: string | null) {
    const { error } = await signUp.finalize();
    if (error) {
      setErrorMessage(ticketError(error));
      setStep("error");
      return;
    }
    await activateAndNavigate(sessionId);
  }

  async function activateAndNavigate(sessionId: string | null) {
    setStep("done");
    try {
      if (sessionId) {
        await setActive({ session: sessionId });
      }
    } catch {
      // setActive failure is non-fatal — /apps will handle org selection
    }
    navigateHard("/apps");
  }

  useEffect(() => {
    if (!ticket) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setErrorMessage("No invitation token found. This link may be invalid or expired.");
      setStep("error");
      return;
    }
    if (!signIn || !signUp) return;
    void accept();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket, signIn, signUp]);

  return (
    <AuthCard title="Joining workspace" subtitle="Just a moment…">
      {step === "loading" && (
        <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-3)", textAlign: "center" }}>
          Accepting invitation…
        </p>
      )}
      {step === "done" && (
        <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-3)", textAlign: "center" }}>
          Invitation accepted. Redirecting…
        </p>
      )}
      {step === "error" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <p role="alert" style={{ margin: 0, fontSize: "13px", color: "var(--red)", textAlign: "center" }}>
            {errorMessage}
          </p>
          {showSignOutLink ? (
            <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-3)", textAlign: "center" }}>
              <button
                onClick={() => void signOut({ redirectUrl: "/sign-in" })}
                style={{ background: "none", border: "none", padding: 0, color: "var(--fg)", textDecoration: "underline", cursor: "pointer", fontSize: "inherit" }}
              >
                Sign in with a different account
              </button>
            </p>
          ) : (
            <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-3)", textAlign: "center" }}>
              <a href="/sign-in" style={{ color: "var(--fg)", textDecoration: "underline" }}>
                Go to sign-in
              </a>
            </p>
          )}
        </div>
      )}
    </AuthCard>
  );
}
