"use client";

import { useState, useTransition } from "react";
import type { AppEnvVar } from "../../../../lib/api-types";
import { setEnvVar, unsetEnvVar, applyEnvVars } from "../actions";

interface Props {
  appId: string;
  initialVars: AppEnvVar[];
  isAdmin: boolean;
  isSuspended: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(isoDate: string): string {
  try {
    const diff = Date.now() - new Date(isoDate).getTime();
    const mins  = Math.floor(diff / 60_000);
    const hours = Math.floor(diff / 3_600_000);
    const days  = Math.floor(diff / 86_400_000);
    if (mins < 2)   return "just now";
    if (hours < 1)  return `${mins}m ago`;
    if (days < 1)   return `${hours}h ago`;
    if (days < 30)  return `${days}d ago`;
    return new Date(isoDate).toLocaleDateString();
  } catch {
    return "";
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  reserved_name:  "That name is reserved.",
  invalid_name:   "Name must be uppercase letters, digits, or underscores and start with a letter or underscore.",
  empty_value:    "Value cannot be empty.",
  value_too_large:"Value exceeds the 32 KB limit.",
  too_many_vars:  "Limit of 50 variables reached.",
  app_suspended:  "Cannot modify variables while the app is suspended.",
  not_authenticated: "Session expired. Please reload.",
};

// ── Main component ────────────────────────────────────────────────────────────

export function EnvSection({ appId, initialVars, isAdmin, isSuspended }: Props) {
  const [vars, setVars]         = useState<AppEnvVar[]>(initialVars);
  const [error, setError]       = useState<string | null>(null);
  const [pendingApply, setPendingApply] = useState(false);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [showAdd, setShowAdd]   = useState(false);
  const [isPending, startTransition] = useTransition();

  async function handleSet(name: string, value: string): Promise<boolean> {
    setError(null);
    const result = await setEnvVar(appId, name, value);
    if (result.error) {
      setError(ERROR_MESSAGES[result.error] ?? "Failed to save variable.");
      return false;
    }
    const now = new Date().toISOString();
    setVars((prev) => {
      const existing = prev.find((v) => v.name === name);
      if (existing) {
        return prev.map((v) => v.name === name ? { ...v, updated_at: now } : v);
      }
      return [...prev, { name, updated_at: now, updated_by_email: null }].sort((a, b) => a.name.localeCompare(b.name));
    });
    setPendingApply(true);
    setApplyMsg(null);
    return true;
  }

  async function handleDelete(name: string) {
    setError(null);
    const result = await unsetEnvVar(appId, name);
    if (result.error) {
      setError(ERROR_MESSAGES[result.error] ?? "Failed to remove variable.");
      return;
    }
    setVars((prev) => prev.filter((v) => v.name !== name));
    setPendingApply(true);
    setApplyMsg(null);
  }

  async function handleApply() {
    setError(null);
    setApplyMsg(null);
    const result = await applyEnvVars(appId);
    if (result.error) {
      setError("Failed to restart app.");
      return;
    }
    setPendingApply(false);
    setApplyMsg(
      result.updated === 0
        ? "No running machines to update."
        : `Updated ${result.updated} machine${result.updated === 1 ? "" : "s"}.`,
    );
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
        gap: "12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>Environment variables</h2>
        {isAdmin && !isSuspended && (
          <button
            onClick={() => { setShowAdd(true); setError(null); }}
            style={ghostBtnStyle}
          >
            Add variable
          </button>
        )}
      </div>

      {isSuspended && isAdmin && (
        <p style={{ margin: 0, fontSize: "12px", color: "var(--fg-3)" }}>
          App is suspended. Variables are read-only until the app is unsuspended.
        </p>
      )}

      {vars.length === 0 ? (
        <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-3)" }}>No variables set.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" }}>
          {vars.map((v) => (
            <VarRow
              key={v.name}
              envVar={v}
              isAdmin={isAdmin}
              isSuspended={isSuspended}
              onReplace={(name, value) => handleSet(name, value)}
              onDelete={(name) => { startTransition(() => { void handleDelete(name); }); }}
            />
          ))}
        </ul>
      )}

      {error && (
        <p style={{ margin: 0, fontSize: "12px", color: "var(--red)" }}>{error}</p>
      )}

      {pendingApply && isAdmin && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
            padding: "8px 12px",
            borderRadius: "8px",
            background: "var(--surface-2)",
            border: "1px solid var(--line)",
            fontSize: "12px",
            color: "var(--fg-2)",
          }}
        >
          <span>Changes apply on next deploy.</span>
          <button
            onClick={() => { startTransition(() => { void handleApply(); }); }}
            disabled={isPending}
            style={{
              height: "26px",
              padding: "0 10px",
              borderRadius: "6px",
              background: "var(--btn-bg)",
              color: "var(--btn-fg)",
              border: "none",
              fontSize: "12px",
              fontWeight: 500,
              cursor: "pointer",
              opacity: isPending ? 0.6 : 1,
            }}
          >
            Restart now
          </button>
        </div>
      )}

      {applyMsg && (
        <p style={{ margin: 0, fontSize: "12px", color: "var(--fg-2)" }}>{applyMsg}</p>
      )}

      {showAdd && (
        <AddVarForm
          onSave={async (name, value) => {
            const ok = await handleSet(name, value);
            if (ok) setShowAdd(false);
          }}
          onCancel={() => { setShowAdd(false); setError(null); }}
        />
      )}
    </div>
  );
}

// ── VarRow ────────────────────────────────────────────────────────────────────

function VarRow({
  envVar,
  isAdmin,
  isSuspended,
  onReplace,
  onDelete,
}: {
  envVar: AppEnvVar;
  isAdmin: boolean;
  isSuspended: boolean;
  onReplace: (name: string, value: string) => Promise<boolean>;
  onDelete: (name: string) => void;
}) {
  const [editing, setEditing]           = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (editing) {
    return (
      <li style={{ padding: "6px 0" }}>
        <AddVarForm
          initialName={envVar.name}
          nameLocked
          onSave={async (name, value) => {
            const ok = await onReplace(name, value);
            if (ok) setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  }

  return (
    <li
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px",
        padding: "7px 0",
        borderBottom: "1px solid var(--line)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
        <span style={{ fontSize: "13px", fontWeight: 500, fontFamily: "monospace" }}>
          {envVar.name}
        </span>
        <span style={{ fontSize: "11px", color: "var(--fg-3)" }}>
          {relativeTime(envVar.updated_at)}
          {envVar.updated_by_email ? ` · ${envVar.updated_by_email}` : ""}
        </span>
      </div>

      {isAdmin && !isSuspended && (
        <div style={{ display: "flex", gap: "4px", flexShrink: 0 }}>
          {confirmDelete ? (
            <>
              <button onClick={() => onDelete(envVar.name)} style={dangerBtnStyle}>Delete</button>
              <button onClick={() => setConfirmDelete(false)} style={ghostBtnStyle}>Cancel</button>
            </>
          ) : (
            <>
              <button onClick={() => setEditing(true)} style={ghostBtnStyle}>Replace</button>
              <button onClick={() => setConfirmDelete(true)} style={ghostBtnStyle}>Remove</button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

// ── AddVarForm ────────────────────────────────────────────────────────────────

function AddVarForm({
  initialName = "",
  nameLocked = false,
  onSave,
  onCancel,
}: {
  initialName?: string;
  nameLocked?: boolean;
  onSave: (name: string, value: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName]       = useState(initialName);
  const [value, setValue]     = useState("");
  const [showVal, setShowVal] = useState(false);
  const [saving, setSaving]   = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !value) return;
    setSaving(true);
    await onSave(name.trim(), value);
    setSaving(false);
  }

  return (
    <form
      onSubmit={submit}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        padding: "10px 12px",
        borderRadius: "8px",
        background: "var(--surface-2)",
        border: "1px solid var(--line)",
      }}
    >
      <input
        type="text"
        value={name}
        readOnly={nameLocked}
        onChange={(e) => setName(e.target.value.toUpperCase())}
        placeholder="VARIABLE_NAME"
        autoFocus={!nameLocked}
        style={{
          ...inputStyle,
          fontFamily: "monospace",
          ...(nameLocked ? { background: "var(--surface)", color: "var(--fg-2)" } : {}),
        }}
      />
      <div style={{ display: "flex", gap: "6px" }}>
        <input
          type={showVal ? "text" : "password"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Value"
          autoFocus={nameLocked}
          style={{ ...inputStyle, flex: 1 }}
        />
        <button
          type="button"
          onClick={() => setShowVal((s) => !s)}
          aria-label={showVal ? "Hide value" : "Show value"}
          style={ghostBtnStyle}
        >
          {showVal ? "Hide" : "Show"}
        </button>
      </div>
      <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
        <button type="button" onClick={onCancel} style={ghostBtnStyle}>Cancel</button>
        <button
          type="submit"
          disabled={saving || !name.trim() || !value}
          style={{
            ...ghostBtnStyle,
            background: "var(--btn-bg)",
            color: "var(--btn-fg)",
            border: "none",
            opacity: saving || !name.trim() || !value ? 0.6 : 1,
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const ghostBtnStyle: React.CSSProperties = {
  height: "26px",
  padding: "0 8px",
  borderRadius: "6px",
  background: "var(--surface-2)",
  border: "1px solid var(--line)",
  color: "var(--fg)",
  fontSize: "12px",
  fontWeight: 500,
  cursor: "pointer",
};

const dangerBtnStyle: React.CSSProperties = {
  height: "26px",
  padding: "0 8px",
  borderRadius: "6px",
  background: "transparent",
  border: "1px solid var(--danger-line)",
  color: "var(--red)",
  fontSize: "12px",
  fontWeight: 500,
  cursor: "pointer",
};

const inputStyle: React.CSSProperties = {
  height: "32px",
  padding: "0 10px",
  borderRadius: "8px",
  background: "var(--input-bg, var(--surface))",
  border: "1px solid var(--line)",
  color: "var(--fg)",
  fontSize: "13px",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};
