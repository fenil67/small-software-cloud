"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSignIn, useSignUp, useClerk } from "@clerk/nextjs";
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

  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const { setActive } = useClerk();

  const [step, setStep] = useState<Step>("loading");
  const [errorMessage, setErrorMessage] = useState<string | undefined>();

  async function accept() {
    // Try sign-in first (existing Clerk account)
    const { error: siError } = await signIn.ticket({ ticket });

    if (!siError && signIn.status === "complete") {
      await finishSignIn(signIn.createdSessionId);
      return;
    }

    // If the error is "account not found" or similar, try sign-up instead
    const siCode = (siError as { errors?: Array<{ code?: string }> } | null)?.errors?.[0]?.code ?? "";
    if (siError && siCode !== "external_account_not_found" && siCode !== "identifier_already_signed_in") {
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

  async function finishSignIn(sessionId: string | null) {
    const { error } = await signIn.finalize();
    if (error) {
      setErrorMessage(ticketError(error));
      setStep("error");
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
          <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-3)", textAlign: "center" }}>
            <a href="/sign-in" style={{ color: "var(--fg)", textDecoration: "underline" }}>
              Go to sign-in
            </a>
          </p>
        </div>
      )}
    </AuthCard>
  );
}
