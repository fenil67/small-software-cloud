"use client";

import { useState, useEffect } from "react";
import { useSession, useUser } from "@clerk/nextjs";
import { CodeStep } from "../../../components/auth/CodeStep";

// ── Style helpers ─────────────────────────────────────────────────────────────

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.5)",
};

const panel: React.CSSProperties = {
  width: "min(440px, calc(100vw - 32px))",
  borderRadius: "14px",
  background: "var(--bg)",
  border: "1px solid var(--line)",
  padding: "24px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

function ghostBtn(overrides?: React.CSSProperties): React.CSSProperties {
  return {
    height: "36px",
    padding: "0 14px",
    borderRadius: "8px",
    border: "1px solid var(--line-strong)",
    background: "transparent",
    color: "var(--fg)",
    fontSize: "13px",
    cursor: "pointer",
    ...overrides,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  /**
   * Called after the user successfully completes step-up verification.
   * The caller should retry the original action here.
   */
  onVerified: () => void;
  onCancel: () => void;
}

/**
 * Custom reverification dialog.
 *
 * On mount, starts Clerk first-factor verification and sends a 6-digit code to
 * the user's primary email. When the user enters the correct code, `onVerified`
 * is called so the caller can retry the original sensitive action.
 */
export function ReverificationDialog({ onVerified, onCancel }: Props) {
  const { session } = useSession();
  const { user }    = useUser();

  const [code, setCode]       = useState("");
  const [error, setError]     = useState<string | undefined>();
  const [verifying, setVerifying] = useState(false);

  const primaryEmail = user?.primaryEmailAddress?.emailAddress ?? "";

  useEffect(() => {
    if (!session || !user) return;
    // Start the verification level, then prepare the email code factor using
    // the user's primary email address ID.
    const primaryEmailId = user.primaryEmailAddressId ?? user.emailAddresses?.[0]?.id ?? "";
    session.startVerification({ level: "first_factor" })
      .then(() => {
        if (primaryEmailId) {
          return session.prepareFirstFactorVerification({
            strategy: "email_code",
            emailAddressId: primaryEmailId,
          });
        }
      })
      .catch(() => {
        // Best-effort: if startVerification fails (e.g. already in progress),
        // try preparing directly.
        if (primaryEmailId) {
          session.prepareFirstFactorVerification({
            strategy: "email_code",
            emailAddressId: primaryEmailId,
          }).catch(() => {});
        }
      });
  }, [session, user]);

  async function handleVerify() {
    if (!session || code.length < 6 || verifying) return;
    setVerifying(true);
    setError(undefined);
    try {
      await session.attemptFirstFactorVerification({ strategy: "email_code", code });
      onVerified();
    } catch {
      setError("Incorrect code. Please try again.");
    } finally {
      setVerifying(false);
    }
  }

  async function handleResend() {
    if (!session || !user) return;
    const primaryEmailId = user.primaryEmailAddressId ?? user.emailAddresses?.[0]?.id ?? "";
    if (!primaryEmailId) return;
    try {
      await session.prepareFirstFactorVerification({
        strategy: "email_code",
        emailAddressId: primaryEmailId,
      });
    } catch {
      // Resend errors are surfaced by CodeStep's cooldown UI.
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reverif-dialog-title"
      style={overlay}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div style={panel}>
        <h3
          id="reverif-dialog-title"
          style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}
        >
          Verify your identity
        </h3>

        <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-2)" }}>
          For security, we sent a 6-digit code to{" "}
          <strong style={{ color: "var(--fg)" }}>{primaryEmail || "your primary email"}</strong>.
          Enter it to continue.
        </p>

        <CodeStep
          email={primaryEmail}
          code={code}
          onChange={setCode}
          onSubmit={handleVerify}
          onResend={handleResend}
          error={error}
          loading={verifying}
        />

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" onClick={onCancel} style={ghostBtn()}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
