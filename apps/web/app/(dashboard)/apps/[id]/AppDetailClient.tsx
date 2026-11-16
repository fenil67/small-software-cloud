"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AppAccess } from "../../../../lib/api-types";
import { deleteApp, grantAccess, revokeAccess } from "../actions";

interface Props {
  appId: string;
  appName: string;
  accessList: AppAccess[];
  isAdmin: boolean;
  showDeleteOnly?: boolean;
}

export function AppDetailClient({ appId, appName, accessList, isAdmin, showDeleteOnly }: Props) {
  if (showDeleteOnly) {
    // Guard: only admins can reach this; page enforces it, component double-checks
    if (!isAdmin) return null;
    return <DeleteSection appId={appId} appName={appName} />;
  }

  return (
    <div
      style={{
        padding: "16px",
        borderRadius: "12px",
        background: "var(--surface)",
        border: "1px solid var(--line)",
        display: "flex",
        flexDirection: "column",
        gap: "16px",
      }}
    >
      <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>Who can open it</h2>

      {/* Access list */}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "6px" }}>
        {accessList.length === 0 && (
          <li style={{ fontSize: "13px", color: "var(--fg-3)" }}>
            Only org members can open this app.
          </li>
        )}
        {accessList.map((entry) => (
          <AccessRow
            key={entry.email}
            entry={entry}
            appId={appId}
            isAdmin={isAdmin}
          />
        ))}
      </ul>

      {isAdmin && <GrantAccessForm appId={appId} />}
    </div>
  );
}

function AccessRow({
  entry,
  appId,
  isAdmin,
}: {
  entry: AppAccess;
  appId: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const isPending = entry.status === "pending";

  function handleRevoke() {
    startTransition(async () => {
      const result = await revokeAccess(appId, entry.email);
      if (result.error) {
        setError(result.error);
      } else {
        router.refresh();
      }
    });
  }

  return (
    <li
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "6px 0",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: "28px",
          height: "28px",
          borderRadius: "50%",
          border: isPending ? "1.5px dashed var(--fg-3)" : "none",
          background: isPending ? "transparent" : "var(--surface-3)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "12px",
          fontWeight: 600,
          flex: "none",
          color: "var(--fg-2)",
        }}
      >
        {isPending ? "?" : (entry.display_name ?? entry.email).charAt(0).toUpperCase()}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {entry.display_name ?? entry.email}
        </span>
        {entry.display_name && (
          <span style={{ display: "block", fontSize: "12px", color: "var(--fg-3)" }}>{entry.email}</span>
        )}
        {isPending && (
          <span style={{ display: "block", fontSize: "11px", color: "var(--fg-3)" }}>Invite pending</span>
        )}
      </span>
      {isAdmin && (
        <button
          type="button"
          disabled={pending}
          onClick={handleRevoke}
          style={{
            padding: "0 8px",
            height: "24px",
            borderRadius: "6px",
            border: "1px solid var(--line-strong)",
            background: "transparent",
            color: "var(--fg-2)",
            fontSize: "12px",
            cursor: pending ? "wait" : "pointer",
          }}
        >
          Remove
        </button>
      )}
      {error && <span style={{ fontSize: "12px", color: "var(--red)" }}>{error}</span>}
    </li>
  );
}

function GrantAccessForm({ appId }: { appId: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setError(undefined);
    startTransition(async () => {
      const result = await grantAccess(appId, trimmed);
      if (result.error) {
        setError(result.error === "already_granted" ? "Already has access." : "Could not grant access.");
      } else {
        setEmail("");
        router.refresh();
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ display: "flex", gap: "8px" }}>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email address"
          required
          style={{
            flex: 1,
            height: "36px",
            padding: "0 10px",
            borderRadius: "8px",
            border: "1px solid var(--line-strong)",
            background: "var(--bg)",
            color: "var(--fg)",
            fontSize: "13px",
          }}
        />
        <button
          type="submit"
          disabled={pending}
          style={{
            height: "36px",
            padding: "0 14px",
            borderRadius: "8px",
            border: 0,
            background: "var(--btn-bg)",
            color: "var(--btn-fg)",
            fontSize: "13px",
            fontWeight: 500,
            cursor: pending ? "wait" : "pointer",
          }}
        >
          {pending ? "Adding..." : "Add"}
        </button>
      </div>
      {error && <p role="alert" style={{ margin: 0, fontSize: "12px", color: "var(--red)" }}>{error}</p>}
    </form>
  );
}

function DeleteSection({ appId, appName }: { appId: string; appName: string }) {
  const router = useRouter();
  const [confirmedName, setConfirmedName] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();

  const canSubmit = confirmedName === appName;

  function handleDelete(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(undefined);
    startTransition(async () => {
      const result = await deleteApp(appId, confirmedName);
      if (result.error) {
        if (result.error === "name_mismatch") {
          setError("App name does not match.");
        } else if (result.error === "org_admin_required") {
          setError("Only admins can delete apps.");
        } else {
          setError("Could not delete app.");
        }
      } else {
        router.replace("/apps");
      }
    });
  }

  return (
    <form onSubmit={handleDelete} style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <label style={{ fontSize: "12px", color: "var(--fg-3)", lineHeight: "16px" }}>
        Type <strong style={{ color: "var(--fg)" }}>{appName}</strong> to confirm
      </label>
      <input
        type="text"
        value={confirmedName}
        onChange={(e) => setConfirmedName(e.target.value)}
        placeholder={appName}
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
      {error && <p role="alert" style={{ margin: 0, fontSize: "12px", color: "var(--red)" }}>{error}</p>}
      <button
        type="submit"
        disabled={!canSubmit || pending}
        style={{
          height: "36px",
          borderRadius: "8px",
          border: 0,
          background: canSubmit ? "var(--red)" : "var(--surface-3)",
          color: canSubmit ? "#fff" : "var(--fg-3)",
          fontSize: "13px",
          fontWeight: 500,
          cursor: !canSubmit || pending ? "not-allowed" : "pointer",
        }}
      >
        {pending ? "Deleting..." : "Delete app"}
      </button>
    </form>
  );
}
