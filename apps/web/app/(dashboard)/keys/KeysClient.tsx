"use client";

import React, { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ApiKey, ApiKeyCreated } from "../../../lib/api-types";
import { createKey, revokeKey } from "./actions";

interface Props {
  keys: ApiKey[];
  isAdmin: boolean;
}

export function KeysClient({ keys, isAdmin }: Props) {
  const [revealedKey, setRevealedKey] = useState<ApiKeyCreated | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* One-time reveal box */}
      {revealedKey && (
        <KeyRevealBox keyData={revealedKey} onDismiss={() => setRevealedKey(null)} />
      )}

      {/* Create form — admin only */}
      {isAdmin && (
        <CreateKeyForm onCreated={(k) => setRevealedKey(k)} />
      )}

      {/* Keys list */}
      {!isAdmin && (
        <p style={{ fontSize: "13px", color: "var(--fg-3)", margin: 0 }}>
          Only admins can create or revoke API keys.
        </p>
      )}

      {keys.length === 0 ? (
        <p style={{ color: "var(--fg-3)", fontSize: "14px", margin: 0 }}>No API keys yet.</p>
      ) : (
        <KeysTable keys={keys} isAdmin={isAdmin} />
      )}
    </div>
  );
}

function KeyRevealBox({ keyData, onDismiss }: { keyData: ApiKeyCreated; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(keyData.key).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        padding: "16px",
        borderRadius: "12px",
        background: "var(--surface)",
        border: "1px solid var(--green)",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <p style={{ margin: 0, fontSize: "13px", fontWeight: 500, color: "var(--green)" }}>
          Key created — copy it now. You will not see it again.
        </p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{ padding: 0, border: 0, background: "transparent", color: "var(--fg-3)", cursor: "pointer", fontSize: "16px" }}
        >
          ×
        </button>
      </div>

      <code
        style={{
          display: "block",
          padding: "10px 12px",
          borderRadius: "8px",
          background: "var(--surface-2)",
          fontFamily: "var(--font-mono, monospace)",
          fontSize: "13px",
          color: "var(--fg)",
          wordBreak: "break-all",
        }}
      >
        {keyData.key}
      </code>

      <div style={{ display: "flex", gap: "8px" }}>
        <button
          type="button"
          onClick={handleCopy}
          style={{
            height: "32px",
            padding: "0 14px",
            borderRadius: "8px",
            border: 0,
            background: "var(--btn-bg)",
            color: "var(--btn-fg)",
            fontSize: "12px",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          {copied ? "Copied" : "Copy key"}
        </button>
      </div>

      <div
        style={{
          fontFamily: "var(--font-mono, monospace)",
          fontSize: "12px",
          color: "var(--fg-3)",
          lineHeight: "20px",
        }}
      >
        <div>$ export UTIR_API_KEY={keyData.key}</div>
        <div>$ npx @utir/ssc deploy</div>
      </div>
    </div>
  );
}

function CreateKeyForm({ onCreated }: { onCreated: (k: ApiKeyCreated) => void }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<string>>(new Set(["read", "deploy"]));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function toggleScope(scope: string) {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) { setError("Name is required."); return; }
    setError(undefined);
    startTransition(async () => {
      const result = await createKey(trimmedName, Array.from(scopes));
      if (result.error) {
        setError("Could not create key.");
      } else if (result.key) {
        setName("");
        setScopes(new Set(["read", "deploy"]));
        onCreated(result.key);
      }
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        padding: "20px",
        borderRadius: "12px",
        background: "var(--surface)",
        border: "1px solid var(--line)",
      }}
    >
      <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>Create API key</h2>

      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <label htmlFor="key-name" style={{ fontSize: "12px", color: "var(--fg-2)", fontWeight: 500 }}>
          Name
        </label>
        <input
          id="key-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. CI deploy key"
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

      <fieldset style={{ border: "1px solid var(--line)", borderRadius: "8px", padding: "12px 14px", margin: 0 }}>
        <legend style={{ fontSize: "12px", color: "var(--fg-2)", fontWeight: 500, padding: "0 4px" }}>
          Permissions
        </legend>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "4px" }}>
          <ScopeCheckbox
            id="scope-read"
            label="Read"
            description="List apps and deployments"
            checked
            disabled
          />
          <ScopeCheckbox
            id="scope-deploy"
            label="Deploy"
            description="Upload and deploy apps"
            checked={scopes.has("deploy")}
            onChange={() => toggleScope("deploy")}
          />
          <ScopeCheckbox
            id="scope-manage"
            label="Manage"
            description="Delete apps, manage access"
            checked={scopes.has("manage")}
            onChange={() => toggleScope("manage")}
          />
        </div>
      </fieldset>

      {error && <p role="alert" style={{ margin: 0, fontSize: "12px", color: "var(--red)" }}>{error}</p>}

      <button
        type="submit"
        disabled={pending}
        style={{
          height: "36px",
          borderRadius: "8px",
          border: 0,
          background: "var(--btn-bg)",
          color: "var(--btn-fg)",
          fontSize: "13px",
          fontWeight: 500,
          cursor: pending ? "wait" : "pointer",
        }}
      >
        {pending ? "Creating..." : "Create key"}
      </button>
    </form>
  );
}

interface ScopeCheckboxProps {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange?: () => void;
}

function ScopeCheckbox({ id, label, description, checked, disabled, onChange }: ScopeCheckboxProps) {
  return (
    <label
      htmlFor={id}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "8px",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        style={{ marginTop: "2px" }}
      />
      <span>
        <span style={{ display: "block", fontSize: "13px", fontWeight: 500 }}>{label}</span>
        <span style={{ display: "block", fontSize: "12px", color: "var(--fg-3)" }}>{description}</span>
      </span>
    </label>
  );
}

function KeysTable({ keys, isAdmin }: { keys: ApiKey[]; isAdmin: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();

  function handleRevoke(keyId: string) {
    if (!confirm("Revoke this key? Apps using it will stop working.")) return;
    setRevoking(keyId);
    startTransition(async () => {
      const result = await revokeKey(keyId);
      setRevoking(null);
      if (result.error) {
        setError("Could not revoke key.");
      } else {
        router.refresh();
      }
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      {error && <p role="alert" style={{ margin: "0 0 8px", fontSize: "12px", color: "var(--red)" }}>{error}</p>}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1.2fr) 110px 120px 96px",
        }}
      >
        {/* Header */}
        {["Name", "Prefix", "Created", "Last used", ""].map((h, i) => (
          <div
            key={i}
            style={{
              padding: "6px 12px",
              fontSize: "12px",
              fontWeight: 500,
              color: "var(--fg-3)",
              borderBottom: "1px solid var(--line)",
            }}
          >
            {h}
          </div>
        ))}

        {/* Rows */}
        {keys.map((k) => {
          const isRevoked = !!k.revoked_at;
          const cellStyle: React.CSSProperties = {
            padding: "10px 12px",
            borderBottom: "1px solid var(--line)",
            display: "flex",
            alignItems: "center",
            fontSize: "13px",
            color: isRevoked ? "var(--fg-3)" : "var(--fg)",
          };
          return (
            <React.Fragment key={k.id}>
              <div style={cellStyle}>
                <span style={{ textDecoration: isRevoked ? "line-through" : "none" }}>
                  {k.name}
                </span>
                {isRevoked && (
                  <span style={{ marginLeft: "6px", fontSize: "11px", color: "var(--fg-3)" }}>
                    revoked
                  </span>
                )}
              </div>
              <div style={{ ...cellStyle, fontFamily: "var(--font-mono, monospace)", fontSize: "12px" }}>
                {k.key_prefix}…
              </div>
              <div style={{ ...cellStyle, color: "var(--fg-2)" }}>
                {formatDate(k.created_at)}
              </div>
              <div style={{ ...cellStyle, color: "var(--fg-2)" }}>
                {k.last_used_at ? formatDate(k.last_used_at) : "—"}
              </div>
              <div style={{ ...cellStyle, justifyContent: "flex-end" }}>
                {isAdmin && !isRevoked && (
                  <button
                    type="button"
                    disabled={revoking === k.id}
                    onClick={() => handleRevoke(k.id)}
                    style={{
                      height: "26px",
                      padding: "0 10px",
                      borderRadius: "6px",
                      border: "1px solid var(--line-strong)",
                      background: "transparent",
                      color: "var(--fg-2)",
                      fontSize: "12px",
                      cursor: revoking === k.id ? "wait" : "pointer",
                    }}
                  >
                    Revoke
                  </button>
                )}
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
