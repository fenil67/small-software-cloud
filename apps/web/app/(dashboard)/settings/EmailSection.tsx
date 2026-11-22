"use client";

import { useState } from "react";
import { useUser } from "@clerk/nextjs";
import { CodeStep } from "../../../components/auth/CodeStep";

type EmailAddressResource = NonNullable<ReturnType<typeof useUser>["user"]>["emailAddresses"][number];

// ── Shared style primitives ───────────────────────────────────────────────────

const S = {
  section: { display: "flex", flexDirection: "column", gap: "16px" } as React.CSSProperties,
  h2: { margin: 0, fontSize: "16px", lineHeight: "24px", fontWeight: 600 } as React.CSSProperties,
  card: {
    padding: "16px",
    borderRadius: "10px",
    border: "1px solid var(--line)",
    background: "var(--surface)",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  } as React.CSSProperties,
  label: { fontSize: "12px", color: "var(--fg-3)", lineHeight: "16px" } as React.CSSProperties,
  input: {
    height: "36px",
    padding: "0 10px",
    borderRadius: "8px",
    border: "1px solid var(--line-strong)",
    background: "var(--bg)",
    color: "var(--fg)",
    fontSize: "13px",
    flex: 1,
    minWidth: 0,
    boxSizing: "border-box",
  } as React.CSSProperties,
  error: { margin: 0, fontSize: "12px", color: "var(--red)" } as React.CSSProperties,
};

function Badge({ children, variant = "neutral" }: { children: React.ReactNode; variant?: "primary" | "verified" | "neutral" }) {
  const bg = variant === "primary" ? "var(--blue)" : variant === "verified" ? "var(--green)" : "var(--surface-3)";
  const color = variant === "neutral" ? "var(--fg-3)" : "#fff";
  return (
    <span style={{
      display: "inline-block",
      padding: "1px 8px",
      borderRadius: "999px",
      background: bg,
      color,
      fontSize: "11px",
      fontWeight: 500,
      lineHeight: "18px",
    }}>
      {children}
    </span>
  );
}

function ghostBtn(style?: React.CSSProperties): React.CSSProperties {
  return {
    height: "30px",
    padding: "0 10px",
    borderRadius: "8px",
    border: "1px solid var(--line-strong)",
    background: "transparent",
    color: "var(--fg)",
    fontSize: "12px",
    cursor: "pointer",
    ...style,
  };
}

export function EmailSection() {
  const { user, isLoaded } = useUser();

  // "add" flow state
  const [addEmail, setAddEmail]       = useState("");
  const [addError, setAddError]       = useState<string | undefined>();
  const [adding, setAdding]           = useState(false);

  // "verify" flow state — set after successfully calling addEmailAddress
  const [verifyResource, setVerifyResource] = useState<EmailAddressResource | null>(null);
  const [verifyCode, setVerifyCode]         = useState("");
  const [verifyError, setVerifyError]       = useState<string | undefined>();
  const [verifying, setVerifying]           = useState(false);

  if (!isLoaded || !user) return null;

  const emails = user.emailAddresses;
  const primaryId = user.primaryEmailAddressId;

  async function handleAdd() {
    if (!addEmail.trim() || adding) return;
    setAdding(true);
    setAddError(undefined);
    try {
      if (!user) return;
      const created = await user.createEmailAddress({ email: addEmail.trim() });
      await created.prepareVerification({ strategy: "email_code" });
      setVerifyResource(created);
      setAddEmail("");
    } catch (err: unknown) {
      const clerkErrors = (err as { errors?: Array<{ message?: string }> }).errors;
      const msg = clerkErrors?.[0]?.message ?? "";
      setAddError(msg || "Could not add email address.");
    } finally {
      setAdding(false);
    }
  }

  async function handleVerify() {
    if (!verifyResource || verifyCode.length < 6 || verifying) return;
    setVerifying(true);
    setVerifyError(undefined);
    try {
      await verifyResource.attemptVerification({ code: verifyCode });
      setVerifyResource(null);
      setVerifyCode("");
    } catch (err: unknown) {
      const clerkErrors = (err as { errors?: Array<{ message?: string }> }).errors;
      const msg = clerkErrors?.[0]?.message ?? "";
      setVerifyError(msg === "is incorrect" || msg.includes("incorrect") ? "Incorrect code. Please try again." : msg || "Verification failed.");
    } finally {
      setVerifying(false);
    }
  }

  async function handleResend() {
    if (!verifyResource) return;
    try {
      await verifyResource.prepareVerification({ strategy: "email_code" });
    } catch {
      // resend errors are surfaced by CodeStep's cooldown UI
    }
  }

  async function handleMakePrimary(email: EmailAddressResource) {
    if (email.id === primaryId || !user) return;
    try {
      await user.update({ primaryEmailAddressId: email.id });
    } catch (err: unknown) {
      const clerkErrors = (err as { errors?: Array<{ message?: string }> }).errors;
      console.error("make primary failed:", clerkErrors?.[0]?.message);
    }
  }

  async function handleRemove(email: EmailAddressResource) {
    if (email.id === primaryId) return;          // never remove primary
    if (emails.length <= 1) return;              // never remove the last one
    try {
      await email.destroy();
    } catch (err: unknown) {
      const clerkErrors = (err as { errors?: Array<{ message?: string }> }).errors;
      console.error("remove email failed:", clerkErrors?.[0]?.message);
    }
  }

  return (
    <section aria-labelledby="email-h" style={S.section}>
      <h2 id="email-h" style={S.h2}>Email addresses</h2>

      <div style={S.card}>
        {/* ── Existing email list ────────────────────────────────────────── */}
        {emails.map((email) => {
          const isPrimary  = email.id === primaryId;
          const isVerified = email.verification?.status === "verified";
          const canRemove  = !isPrimary && emails.length > 1;
          const canMakePrimary = !isPrimary && isVerified;

          return (
            <div
              key={email.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                padding: "10px 12px",
                borderRadius: "8px",
                border: "1px solid var(--line)",
                background: "var(--bg)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                <span style={{ fontSize: "13px", color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {email.emailAddress}
                </span>
                {isPrimary  && <Badge variant="primary">Primary</Badge>}
                {isVerified && !isPrimary && <Badge variant="verified">Verified</Badge>}
                {!isVerified && <Badge>Unverified</Badge>}
              </div>

              <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                {canMakePrimary && (
                  <button
                    type="button"
                    onClick={() => handleMakePrimary(email)}
                    style={ghostBtn()}
                    aria-label={`Make ${email.emailAddress} primary`}
                  >
                    Make primary
                  </button>
                )}
                {!isVerified && (
                  <button
                    type="button"
                    onClick={async () => {
                      setVerifyResource(email);
                      setVerifyCode("");
                      setVerifyError(undefined);
                      await email.prepareVerification({ strategy: "email_code" });
                    }}
                    style={ghostBtn()}
                    aria-label={`Verify ${email.emailAddress}`}
                  >
                    Verify
                  </button>
                )}
                {canRemove && (
                  <button
                    type="button"
                    onClick={() => handleRemove(email)}
                    aria-label={`Remove ${email.emailAddress}`}
                    style={ghostBtn({ color: "var(--red)", borderColor: "var(--red)" })}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          );
        })}

        <hr style={{ margin: 0, border: 0, borderTop: "1px solid var(--line)" }} />

        {/* ── Verify flow (CodeStep) ─────────────────────────────────────── */}
        {verifyResource && (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-2)" }}>
              Enter the 6-digit code sent to <strong>{verifyResource.emailAddress}</strong>.
            </p>
            <CodeStep
              email={verifyResource.emailAddress}
              code={verifyCode}
              onChange={setVerifyCode}
              onSubmit={handleVerify}
              onResend={handleResend}
              error={verifyError}
              loading={verifying}
            />
            <button
              type="button"
              onClick={() => { setVerifyResource(null); setVerifyCode(""); setVerifyError(undefined); }}
              style={{ ...ghostBtn(), alignSelf: "flex-start", fontSize: "12px", color: "var(--fg-3)" }}
            >
              Cancel
            </button>
          </div>
        )}

        {/* ── Add email ──────────────────────────────────────────────────── */}
        {!verifyResource && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <label htmlFor="add-email" style={S.label}>Add email address</label>
            <div style={{ display: "flex", gap: "8px" }}>
              <input
                id="add-email"
                type="email"
                value={addEmail}
                onChange={(e) => { setAddEmail(e.target.value); setAddError(undefined); }}
                placeholder="you@example.com"
                autoComplete="email"
                style={S.input}
                onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
              />
              <button
                type="button"
                onClick={handleAdd}
                disabled={!addEmail.trim() || adding}
                style={{
                  height: "36px",
                  padding: "0 14px",
                  borderRadius: "8px",
                  border: 0,
                  background: !addEmail.trim() || adding ? "var(--surface-3)" : "var(--btn-bg)",
                  color: !addEmail.trim() || adding ? "var(--fg-3)" : "var(--btn-fg)",
                  fontSize: "13px",
                  fontWeight: 500,
                  cursor: !addEmail.trim() || adding ? "not-allowed" : "pointer",
                  flexShrink: 0,
                }}
              >
                {adding ? "Sending…" : "Add"}
              </button>
            </div>
            {addError && <p role="alert" style={S.error}>{addError}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
