"use client";

import { useState, useTransition } from "react";
import { useUser } from "@clerk/nextjs";
import { deleteAccount } from "./actions";
import { navigateHard } from "../../../lib/navigate";
import type { DeleteMeBlockedResponse } from "../../../lib/api-types";
import { ReverificationDialog } from "./ReverificationDialog";

// ── Style primitives ──────────────────────────────────────────────────────────

const S = {
  section: { display: "flex", flexDirection: "column", gap: "16px" } as React.CSSProperties,
  h2: { margin: 0, fontSize: "16px", lineHeight: "24px", fontWeight: 600 } as React.CSSProperties,
  error: { margin: 0, fontSize: "12px", color: "var(--red)" } as React.CSSProperties,
  label: { fontSize: "12px", color: "var(--fg-3)", lineHeight: "16px" } as React.CSSProperties,
  input: {
    height: "36px",
    padding: "0 10px",
    borderRadius: "8px",
    border: "1px solid var(--line-strong)",
    background: "var(--bg)",
    color: "var(--fg)",
    fontSize: "13px",
    width: "100%",
    boxSizing: "border-box",
  } as React.CSSProperties,
};

export function DeleteAccountSection() {
  const { user, isLoaded } = useUser();
  const [open, setOpen]               = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [deleteError, setDeleteError] = useState<string | undefined>();
  const [blocked, setBlocked]         = useState<DeleteMeBlockedResponse | undefined>();
  const [deleting, startDeleteTransition] = useTransition();
  const [reverifying, setReverifying] = useState(false);
  // The email to retry with after reverification completes
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  if (!isLoaded || !user) return null;

  const primaryEmail = user.primaryEmailAddress?.emailAddress ?? "";
  const canDelete    = confirmEmail.trim().toLowerCase() === primaryEmail.toLowerCase() && !deleting;

  function openDialog() {
    setConfirmEmail("");
    setDeleteError(undefined);
    setBlocked(undefined);
    setOpen(true);
  }

  function closeDialog() {
    if (deleting) return;
    setOpen(false);
  }

  function handleDelete(e: React.FormEvent) {
    e.preventDefault();
    if (!canDelete) return;
    setDeleteError(undefined);
    setBlocked(undefined);

    const emailToUse = confirmEmail.trim();
    startDeleteTransition(async () => {
      const result = await deleteAccount(emailToUse);
      if (result.error) {
        if (result.error === "reverification_required") {
          setPendingEmail(emailToUse);
          setOpen(false);
          setReverifying(true);
          return;
        }
        if (result.error === "sole_admin_blocked" && result.blocked) {
          setBlocked(result.blocked);
        } else if (result.error === "email_mismatch") {
          setDeleteError("Email does not match.");
        } else {
          setDeleteError("Could not delete account. Please try again.");
        }
        return;
      }
      // Sign out happens automatically when Clerk sees the account is deleted.
      navigateHard("/sign-in");
    });
  }

  function handleReverified() {
    setReverifying(false);
    if (!pendingEmail) return;
    const email = pendingEmail;
    setPendingEmail(null);
    startDeleteTransition(async () => {
      const result = await deleteAccount(email);
      if (result.error) {
        if (result.error === "sole_admin_blocked" && result.blocked) {
          setBlocked(result.blocked);
        } else if (result.error === "email_mismatch") {
          setDeleteError("Email does not match.");
        } else {
          setDeleteError("Could not delete account. Please try again.");
        }
        return;
      }
      navigateHard("/sign-in");
    });
  }

  return (
    <section aria-labelledby="delete-account-h" style={S.section}>
      {reverifying && (
        <ReverificationDialog
          onVerified={handleReverified}
          onCancel={() => { setReverifying(false); setPendingEmail(null); }}
        />
      )}
      <h2 id="delete-account-h" style={{ ...S.h2, color: "var(--red)" }}>
        Delete account
      </h2>

      <div
        style={{
          padding: "16px",
          borderRadius: "10px",
          border: "1px solid var(--red)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "16px",
        }}
      >
        <div>
          <p style={{ margin: 0, fontSize: "14px", fontWeight: 500 }}>
            Permanently delete your account
          </p>
          <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--fg-3)" }}>
            Removes your profile, sole-member workspaces, and all associated data. This cannot be undone.
          </p>
        </div>
        <button
          type="button"
          onClick={openDialog}
          style={{
            flexShrink: 0,
            height: "34px",
            padding: "0 14px",
            borderRadius: "8px",
            border: "1px solid var(--red)",
            background: "transparent",
            color: "var(--red)",
            fontSize: "13px",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          Delete account
        </button>
      </div>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-account-dialog-title"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.5)",
          }}
          onClick={(e) => { if (e.target === e.currentTarget) closeDialog(); }}
        >
          <div
            style={{
              width: "min(480px, calc(100vw - 32px))",
              borderRadius: "14px",
              background: "var(--bg)",
              border: "1px solid var(--line)",
              padding: "24px",
              display: "flex",
              flexDirection: "column",
              gap: "16px",
            }}
          >
            <h3
              id="delete-account-dialog-title"
              style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}
            >
              Delete account?
            </h3>

            <ul
              style={{
                margin: 0,
                padding: 0,
                listStyle: "none",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                fontSize: "13px",
                color: "var(--fg-2)",
              }}
            >
              <li>Your profile and account data will be permanently deleted.</li>
              <li>Workspaces where you are the only member will be deleted.</li>
              <li>Your API keys will be revoked.</li>
              <li>You will be signed out immediately.</li>
            </ul>

            {blocked && (
              <div
                role="alert"
                style={{
                  padding: "12px",
                  borderRadius: "8px",
                  background: "var(--surface-2)",
                  border: "1px solid var(--line)",
                  fontSize: "13px",
                  color: "var(--fg-2)",
                }}
              >
                <p style={{ margin: "0 0 8px", fontWeight: 500, color: "var(--fg)" }}>
                  You are the only admin of:
                </p>
                <ul style={{ margin: 0, paddingLeft: "16px" }}>
                  {blocked.workspaces.map((ws) => (
                    <li key={ws.id}>{ws.name}</li>
                  ))}
                </ul>
                <p style={{ margin: "8px 0 0", color: "var(--fg-3)" }}>
                  Make someone else an admin in those workspaces first.
                </p>
              </div>
            )}

            <form
              onSubmit={handleDelete}
              style={{ display: "flex", flexDirection: "column", gap: "10px" }}
            >
              <label
                htmlFor="confirm-delete-email"
                style={S.label}
              >
                Type <strong style={{ color: "var(--fg)" }}>{primaryEmail}</strong> to confirm
              </label>
              <input
                id="confirm-delete-email"
                type="email"
                value={confirmEmail}
                onChange={(e) => { setConfirmEmail(e.target.value); setDeleteError(undefined); setBlocked(undefined); }}
                placeholder={primaryEmail}
                disabled={deleting}
                autoComplete="off"
                style={S.input}
              />
              {deleteError && (
                <p role="alert" style={S.error}>{deleteError}</p>
              )}
              <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={closeDialog}
                  disabled={deleting}
                  style={{
                    height: "36px",
                    padding: "0 14px",
                    borderRadius: "8px",
                    border: "1px solid var(--line-strong)",
                    background: "transparent",
                    color: "var(--fg)",
                    fontSize: "13px",
                    cursor: deleting ? "not-allowed" : "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!canDelete}
                  style={{
                    height: "36px",
                    padding: "0 14px",
                    borderRadius: "8px",
                    border: 0,
                    background: canDelete ? "var(--red)" : "var(--surface-3)",
                    color: canDelete ? "#fff" : "var(--fg-3)",
                    fontSize: "13px",
                    fontWeight: 500,
                    cursor: canDelete ? "pointer" : "not-allowed",
                  }}
                >
                  {deleting ? "Deleting…" : "Delete account"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
