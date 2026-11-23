"use client";

import { useState, useTransition, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import {
  fetchWorkspaceMembers,
  inviteMember,
  revokeInvitation,
  resendInvitation,
  changeMemberRole,
  removeMember,
  leaveWorkspace,
} from "./actions";
import type { WorkspaceMembersResponse, WorkspaceMember, WorkspaceInvitation } from "../../../lib/api-types";
import { navigateHard } from "../../../lib/navigate";

// ── Style primitives ──────────────────────────────────────────────────────────

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
    gap: "0",
  } as React.CSSProperties,
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "10px 0",
    borderBottom: "1px solid var(--line)",
  } as React.CSSProperties,
  rowLast: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "10px 0",
  } as React.CSSProperties,
  label: { fontSize: "12px", color: "var(--fg-3)" } as React.CSSProperties,
  error: { margin: 0, fontSize: "12px", color: "var(--red)" } as React.CSSProperties,
};

function btnSmall(variant: "default" | "danger" | "primary"): React.CSSProperties {
  const base: React.CSSProperties = {
    height: "28px",
    padding: "0 10px",
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: 500,
    cursor: "pointer",
  };
  if (variant === "danger")  return { ...base, background: "transparent", border: "1px solid var(--red)", color: "var(--red)" };
  if (variant === "primary") return { ...base, background: "var(--btn-bg)", border: 0, color: "var(--btn-fg)" };
  return { ...base, background: "transparent", border: "1px solid var(--line-strong)", color: "var(--fg)" };
}

function roleBadge(role: string): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "1px 7px",
    borderRadius: "4px",
    fontSize: "11px",
    fontWeight: 500,
    background: role === "org:admin" ? "var(--surface-3)" : "var(--surface-2)",
    color: role === "org:admin" ? "var(--fg)" : "var(--fg-2)",
  };
}

function displayName(m: WorkspaceMember): string {
  const parts = [m.firstName, m.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : m.email;
}

function roleLabel(role: string): string {
  if (role === "org:admin") return "Admin";
  return "Member";
}

// ── Invite dialog ─────────────────────────────────────────────────────────────

interface InviteDialogProps {
  onClose: () => void;
  onInvited: () => void;
}

function InviteDialog({ onClose, onInvited }: InviteDialogProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("org:member");
  const [error, setError] = useState<string | undefined>();
  const [inviting, startInviteTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inviting) return;
    setError(undefined);
    startInviteTransition(async () => {
      const r = await inviteMember(email.trim().toLowerCase(), role);
      if (r.error) {
        if (r.error === "already_member") setError("That person is already a member.");
        else if (r.error === "invite_rate_limit") setError("Invite limit reached. Try again tomorrow.");
        else if (r.error === "invalid_email") setError("Please enter a valid email address.");
        else setError("Could not send invitation. Please try again.");
        return;
      }
      onInvited();
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-dialog-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.5)",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: "min(400px, calc(100vw - 32px))",
          borderRadius: "14px",
          background: "var(--bg)",
          border: "1px solid var(--line)",
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <h3 id="invite-dialog-title" style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>
          Invite to workspace
        </h3>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <label htmlFor="invite-email" style={S.label}>Email address</label>
            <input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(undefined); }}
              placeholder="name@example.com"
              disabled={inviting}
              style={{
                height: "36px",
                padding: "0 10px",
                borderRadius: "8px",
                border: "1px solid var(--line-strong)",
                background: "var(--bg)",
                color: "var(--fg)",
                fontSize: "13px",
              }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <label htmlFor="invite-role" style={S.label}>Role</label>
            <select
              id="invite-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              disabled={inviting}
              style={{
                height: "36px",
                padding: "0 10px",
                borderRadius: "8px",
                border: "1px solid var(--line-strong)",
                background: "var(--bg)",
                color: "var(--fg)",
                fontSize: "13px",
              }}
            >
              <option value="org:member">Member</option>
              <option value="org:admin">Admin</option>
            </select>
          </div>
          {error && <p role="alert" style={S.error}>{error}</p>}
          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
            <button type="button" onClick={onClose} disabled={inviting} style={btnSmall("default")}>
              Cancel
            </button>
            <button type="submit" disabled={inviting || !email.trim()} style={btnSmall("primary")}>
              {inviting ? "Inviting…" : "Send invite"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  isAdmin: boolean;
}

export function MembersSection({ isAdmin }: Props) {
  const { user } = useUser();
  const [data, setData] = useState<WorkspaceMembersResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | undefined>();
  const [showInvite, setShowInvite] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  const [leaving, startLeaveTransition] = useTransition();
  const [mutating, startMutateTransition] = useTransition();

  async function load() {
    setFetchError(undefined);
    const r = await fetchWorkspaceMembers();
    if ("error" in r) {
      setFetchError("Could not load members.");
    } else {
      setData(r);
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, []);

  function handleInvited() {
    setShowInvite(false);
    void load();
  }

  function handleRemoveMember(clerkUserId: string) {
    setActionError(undefined);
    startMutateTransition(async () => {
      const r = await removeMember(clerkUserId);
      if (r.error) {
        if (r.error === "last_admin") setActionError("Cannot remove the last admin.");
        else setActionError("Could not remove member. Please try again.");
        return;
      }
      void load();
    });
  }

  function handleChangeRole(clerkUserId: string, newRole: string) {
    setActionError(undefined);
    startMutateTransition(async () => {
      const r = await changeMemberRole(clerkUserId, newRole);
      if (r.error) {
        if (r.error === "last_admin") setActionError("Cannot change the last admin's role.");
        else setActionError("Could not change role. Please try again.");
        return;
      }
      void load();
    });
  }

  function handleRevokeInvite(inviteId: string) {
    setActionError(undefined);
    startMutateTransition(async () => {
      const r = await revokeInvitation(inviteId);
      if (r.error) {
        setActionError("Could not revoke invitation. Please try again.");
        return;
      }
      void load();
    });
  }

  function handleResendInvite(inviteId: string) {
    setActionError(undefined);
    startMutateTransition(async () => {
      const r = await resendInvitation(inviteId);
      if (r.error) {
        setActionError("Could not resend invitation. Please try again.");
        return;
      }
      void load();
    });
  }

  function handleLeave() {
    setActionError(undefined);
    startLeaveTransition(async () => {
      const r = await leaveWorkspace();
      if (r.error) {
        if (r.error === "last_admin") setActionError("You are the last admin. Transfer admin rights before leaving.");
        else setActionError("Could not leave workspace. Please try again.");
        return;
      }
      navigateHard("/onboarding");
    });
  }

  const myClerkId = user?.id ?? "";

  const members: WorkspaceMember[]       = data?.members     ?? [];
  const invitations: WorkspaceInvitation[] = data?.invitations ?? [];

  return (
    <section aria-labelledby="members-h" style={S.section}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 id="members-h" style={S.h2}>Members</h2>
        {isAdmin && (
          <button type="button" onClick={() => setShowInvite(true)} style={btnSmall("primary")}>
            Invite
          </button>
        )}
      </div>

      {fetchError && <p role="alert" style={S.error}>{fetchError}</p>}
      {actionError && <p role="alert" style={S.error}>{actionError}</p>}

      {!fetchError && data && (
        <div style={S.card}>
          {members.map((m, idx) => {
            const isMe = m.userId === myClerkId;
            const isLast = idx === members.length - 1 && invitations.length === 0;
            return (
              <div key={m.userId} style={isLast ? S.rowLast : S.row}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--fg)" }}>
                      {displayName(m)}
                    </span>
                    {isMe && (
                      <span style={{ fontSize: "11px", color: "var(--fg-3)", border: "1px solid var(--line)", borderRadius: "4px", padding: "0 5px" }}>
                        You
                      </span>
                    )}
                    <span style={roleBadge(m.role)}>{roleLabel(m.role)}</span>
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--fg-3)", marginTop: "2px" }}>{m.email}</div>
                </div>
                {isAdmin && !isMe && (
                  <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                    <select
                      aria-label={`Change role for ${m.email}`}
                      value={m.role}
                      onChange={(e) => handleChangeRole(m.userId, e.target.value)}
                      disabled={mutating}
                      style={{
                        height: "28px",
                        padding: "0 8px",
                        borderRadius: "6px",
                        border: "1px solid var(--line-strong)",
                        background: "var(--bg)",
                        color: "var(--fg)",
                        fontSize: "12px",
                        cursor: mutating ? "not-allowed" : "pointer",
                      }}
                    >
                      <option value="org:member">Member</option>
                      <option value="org:admin">Admin</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => handleRemoveMember(m.userId)}
                      disabled={mutating}
                      style={btnSmall("danger")}
                    >
                      Remove
                    </button>
                  </div>
                )}
                {isMe && !isAdmin && (
                  <button
                    type="button"
                    onClick={handleLeave}
                    disabled={leaving}
                    style={btnSmall("danger")}
                  >
                    {leaving ? "Leaving…" : "Leave"}
                  </button>
                )}
              </div>
            );
          })}

          {invitations.map((inv, idx) => {
            const isLast = idx === invitations.length - 1;
            return (
              <div key={inv.id} style={isLast ? S.rowLast : S.row}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontSize: "13px", color: "var(--fg-2)" }}>{inv.emailAddress}</span>
                    <span style={{ fontSize: "11px", color: "var(--fg-3)", border: "1px solid var(--line)", borderRadius: "4px", padding: "0 5px" }}>
                      Pending
                    </span>
                    <span style={roleBadge(inv.role)}>{roleLabel(inv.role)}</span>
                  </div>
                </div>
                {isAdmin && (
                  <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => handleResendInvite(inv.id)}
                      disabled={mutating}
                      style={btnSmall("default")}
                    >
                      Resend
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRevokeInvite(inv.id)}
                      disabled={mutating}
                      style={btnSmall("danger")}
                    >
                      Revoke
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {members.length === 0 && invitations.length === 0 && (
            <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-3)", padding: "8px 0" }}>
              No members yet.
            </p>
          )}
        </div>
      )}

      {/* Leave button for admins (shown below the list to avoid confusion) */}
      {isAdmin && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={handleLeave}
            disabled={leaving}
            style={btnSmall("danger")}
          >
            {leaving ? "Leaving…" : "Leave workspace"}
          </button>
        </div>
      )}

      {showInvite && <InviteDialog onClose={() => setShowInvite(false)} onInvited={handleInvited} />}
    </section>
  );
}
