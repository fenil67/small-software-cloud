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
    <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>
      {/* One-time reveal box */}
      {revealedKey && (
        <KeyRevealBox keyData={revealedKey} onDismiss={() => setRevealedKey(null)} />
      )}

      {/* Two-column layout: keys list + create form */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "24px", alignItems: "flex-start" }}>
        {/* Keys list */}
        <section
          aria-labelledby="keys-h"
          style={{
            flex: "2 1 520px",
            minWidth: 0,
            borderRadius: "16px",
            background: "var(--surface)",
            border: "1px solid var(--line)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "20px 24px" }}>
            <h2 id="keys-h" style={{ margin: 0, fontSize: "16px", lineHeight: "24px", fontWeight: 600 }}>
              Your keys
            </h2>
          </div>
          {!isAdmin && (
            <p style={{ fontSize: "13px", color: "var(--fg-3)", margin: "0 24px 20px" }}>
              Only admins can create or revoke API keys.
            </p>
          )}
          {keys.length === 0 ? (
            <p style={{ color: "var(--fg-3)", fontSize: "14px", margin: "0 24px 20px" }}>
              No API keys yet.
            </p>
          ) : (
            <KeysTable keys={keys} isAdmin={isAdmin} />
          )}
        </section>

        {/* Create form — admin only */}
        {isAdmin && (
          <section
            aria-labelledby="create-h"
            style={{
              flex: "1 1 320px",
              minWidth: 0,
              borderRadius: "16px",
              background: "var(--surface)",
              border: "1px solid var(--line)",
              padding: "20px 24px 24px",
              display: "flex",
              flexDirection: "column",
              gap: "16px",
            }}
          >
            <h2 id="create-h" style={{ margin: 0, fontSize: "16px", lineHeight: "24px", fontWeight: 600 }}>
              Create a key
            </h2>
            <CreateKeyForm onCreated={(k) => setRevealedKey(k)} />
          </section>
        )}
      </div>
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
    <section
      role="status"
      aria-live="polite"
      aria-labelledby="new-key-h"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        padding: "24px",
        borderRadius: "16px",
        background: "var(--surface)",
        border: "1px solid var(--line-strong)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <h2 id="new-key-h" style={{ margin: 0, fontSize: "16px", lineHeight: "24px", fontWeight: 600 }}>
          Copy your new key now
        </h2>
        <p style={{ margin: 0, fontSize: "14px", lineHeight: "20px", color: "var(--fg-2)" }}>
          For your safety we only show it once. If you lose it, revoke it and make a new one.
        </p>
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "8px",
          padding: "8px 8px 8px 16px",
          borderRadius: "12px",
          background: "var(--bg)",
          border: "1px solid var(--line)",
        }}
      >
        <code
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: "var(--font-mono, monospace)",
            fontSize: "13px",
            lineHeight: "20px",
            overflowWrap: "anywhere",
          }}
        >
          {keyData.key}
        </code>
        <button
          type="button"
          onClick={handleCopy}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            height: "36px",
            padding: "0 12px",
            borderRadius: "8px",
            border: 0,
            background: "var(--btn-bg)",
            color: "var(--btn-fg)",
            fontSize: "13px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a1 1 0 0 1 1-1h9" />
          </svg>
          {copied ? "Copied" : "Copy key"}
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <span style={{ fontSize: "13px", lineHeight: "16px", fontWeight: 500, color: "var(--fg-2)" }}>
          Then, in your terminal
        </span>
        <code
          style={{
            display: "block",
            padding: "12px 16px",
            borderRadius: "12px",
            background: "var(--bg)",
            border: "1px solid var(--line)",
            fontFamily: "var(--font-mono, monospace)",
            fontSize: "13px",
            lineHeight: "22px",
            whiteSpace: "pre-line",
          }}
        >
          {"npx @utir/ssc login\nnpx @utir/ssc deploy ."}
        </code>
      </div>

      <div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{
            height: "32px",
            padding: "0 12px",
            borderRadius: "8px",
            border: "1px solid var(--line-strong)",
            background: "transparent",
            color: "var(--fg-3)",
            fontSize: "13px",
            cursor: "pointer",
          }}
        >
          Done
        </button>
      </div>
    </section>
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
      style={{ display: "flex", flexDirection: "column", gap: "16px", margin: 0 }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <label
          htmlFor="key-name"
          style={{ fontSize: "13px", lineHeight: "16px", fontWeight: 500, color: "var(--fg-2)" }}
        >
          Name
        </label>
        <input
          id="key-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="work laptop"
          style={{
            height: "40px",
            boxSizing: "border-box",
            borderRadius: "10px",
            border: "1px solid var(--line-strong)",
            background: "var(--bg)",
            color: "var(--fg)",
            padding: "0 12px",
            fontSize: "14px",
            lineHeight: "20px",
          }}
        />
      </div>

      <fieldset style={{ margin: 0, padding: 0, border: 0, display: "flex", flexDirection: "column", gap: "12px" }}>
        <legend style={{ padding: "0 0 8px", fontSize: "13px", lineHeight: "16px", fontWeight: 500, color: "var(--fg-2)" }}>
          What it can do
        </legend>
        <ScopeCheckbox
          id="scope-read"
          label="Read"
          description="See your apps and deploy status. Always on."
          checked
          disabled
        />
        <ScopeCheckbox
          id="scope-deploy"
          label="Deploy"
          description="Ship new apps and new versions."
          checked={scopes.has("deploy")}
          onChange={() => toggleScope("deploy")}
        />
        <ScopeCheckbox
          id="scope-manage"
          label="Manage"
          description="Share, unshare and delete apps. Give this only to tools you trust."
          checked={scopes.has("manage")}
          onChange={() => toggleScope("manage")}
        />
      </fieldset>

      {error && <p role="alert" style={{ margin: 0, fontSize: "12px", color: "var(--red)" }}>{error}</p>}

      <button
        type="submit"
        disabled={pending}
        style={{
          height: "40px",
          borderRadius: "10px",
          border: 0,
          background: "var(--btn-bg)",
          color: "var(--btn-fg)",
          fontSize: "14px",
          fontWeight: 600,
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
        gap: "12px",
        alignItems: "flex-start",
        fontSize: "14px",
        lineHeight: "20px",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        style={{ marginTop: "3px", accentColor: "var(--fg)" }}
      />
      <span style={{ display: "flex", flexDirection: "column" }}>
        <span>{label}</span>
        <span style={{ fontSize: "12px", lineHeight: "16px", color: "var(--fg-3)" }}>{description}</span>
      </span>
    </label>
  );
}

function formatScopesDisplay(scopes: string[] | undefined): string {
  if (!scopes || scopes.length === 0) return "Read";
  const order = ["read", "deploy", "manage"];
  const sorted = [...scopes].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return sorted.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(", ");
}

function KeysTable({ keys, isAdmin }: { keys: ApiKey[]; isAdmin: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();

  function handleRevoke(keyId: string, keyName: string) {
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
    <div style={{ overflowX: "auto" }}>
      {error && <p role="alert" style={{ margin: "0 24px 8px", fontSize: "12px", color: "var(--red)" }}>{error}</p>}
      <div style={{ minWidth: "620px" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1.2fr) 110px 120px 96px",
            gap: "16px",
            padding: "12px 24px",
            fontSize: "12px",
            lineHeight: "16px",
            fontWeight: 500,
            color: "var(--fg-3)",
            background: "var(--surface-2)",
          }}
        >
          <span>Name</span>
          <span>Can</span>
          <span>Created</span>
          <span>Last used</span>
          <span>
            <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
              Actions
            </span>
          </span>
        </div>

        {keys.map((k) => {
          const isRevoked = !!k.revoked_at;
          const cellStyle: React.CSSProperties = {
            padding: "14px 24px",
            borderTop: "1px solid var(--line)",
            display: "flex",
            alignItems: "center",
            fontSize: "13px",
            color: isRevoked ? "var(--fg-3)" : "var(--fg)",
          };
          return (
            <div
              key={k.id}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1.2fr) 110px 120px 96px",
                gap: "16px",
                alignItems: "center",
              }}
            >
              <div style={cellStyle}>
                <span style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: "14px", fontWeight: 500, textDecoration: isRevoked ? "line-through" : "none" }}>
                    {k.name}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--font-mono, monospace)",
                      fontSize: "12px",
                      color: "var(--fg-3)",
                    }}
                  >
                    {k.key_prefix}…
                  </span>
                </span>
              </div>
              <div style={{ ...cellStyle, color: "var(--fg-2)" }}>
                {formatScopesDisplay(k.scopes)}
              </div>
              <div style={{ ...cellStyle, color: "var(--fg-2)" }}>
                {formatDate(k.created_at)}
              </div>
              <div style={{ ...cellStyle, color: "var(--fg-2)" }}>
                {isRevoked && k.revoked_at
                  ? `Revoked ${formatDate(k.revoked_at)}`
                  : k.last_used_at
                  ? formatDate(k.last_used_at)
                  : "—"}
              </div>
              <div style={{ ...cellStyle, justifyContent: "flex-end" }}>
                {isAdmin && !isRevoked && (
                  <button
                    type="button"
                    disabled={revoking === k.id}
                    onClick={() => handleRevoke(k.id, k.name)}
                    aria-label={`Revoke ${k.name}`}
                    style={{
                      height: "32px",
                      borderRadius: "8px",
                      border: "1px solid var(--line-strong)",
                      background: "transparent",
                      color: "var(--red)",
                      fontSize: "13px",
                      fontWeight: 500,
                      cursor: revoking === k.id ? "wait" : "pointer",
                      padding: "0 12px",
                    }}
                  >
                    Revoke
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
