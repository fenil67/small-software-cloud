"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import type { App } from "../../lib/api-types";
import { resolveAppStatus, type ResolvedStatus } from "../../lib/status";
import { AppStatusBadge } from "./AppStatusBadge";
import { appUrl } from "../../lib/app-url";

type FilterKey = "All" | "Live" | "Needs attention";

interface Props {
  apps: App[];
  isOrgAdmin?: boolean;
}

function needsAttention(status: ResolvedStatus): boolean {
  return status === "Failed" || status === "Suspended";
}

/** Returns just the hostname (e.g. "ssc-x.fly.dev") with no scheme. */
function hostOnly(subdomain: string | null | undefined): string | null {
  const url = appUrl(subdomain);
  if (!url) return null;
  return url.slice("https://".length);
}

export function AppsTable({ apps, isOrgAdmin = false }: Props) {
  const [tab, setTab] = useState<FilterKey>("All");
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const resolvedApps = apps.map((a) => ({
    ...a,
    resolved: resolveAppStatus(a.suspended, a.status, a.latest_deployment_status),
  }));

  const liveCount = resolvedApps.filter((a) => a.resolved === "Live").length;
  const needsAttentionCount = resolvedApps.filter((a) => needsAttention(a.resolved)).length;

  const filtered = resolvedApps.filter((a) => {
    const matchesTab =
      tab === "All" ||
      (tab === "Live" && a.resolved === "Live") ||
      (tab === "Needs attention" && needsAttention(a.resolved));
    const matchesSearch = !search || a.name.toLowerCase().includes(search.toLowerCase());
    return matchesTab && matchesSearch;
  });

  const tabDefs: { key: FilterKey; label: string }[] = [
    { key: "All", label: `All ${apps.length}` },
    { key: "Live", label: `Live ${liveCount}` },
    { key: "Needs attention", label: `Needs attention ${needsAttentionCount}` },
  ];

  function handleCloseDialog() {
    setDialogOpen(false);
    triggerRef.current?.focus();
  }

  function handleCopyCommand() {
    navigator.clipboard.writeText("npx @utir/ssc deploy .").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>
      {/* Page header */}
      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: "16px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <h1
            style={{
              margin: 0,
              fontSize: "30px",
              lineHeight: "36px",
              fontWeight: 600,
              letterSpacing: "-0.02em",
            }}
          >
            Apps
          </h1>
          {apps.length > 0 && (
            <p style={{ margin: 0, fontSize: "14px", lineHeight: "20px", color: "var(--fg-2)" }}>
              {`${apps.length} app${apps.length === 1 ? "" : "s"}${liveCount > 0 ? ` · ${liveCount} live` : ""}${needsAttentionCount > 0 ? ` · ${needsAttentionCount} need${needsAttentionCount === 1 ? "s" : ""} your attention` : ""}`}
            </p>
          )}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "12px" }}>
          <label style={{ position: "relative", display: "flex", alignItems: "center" }}>
            <span
              style={{
                position: "absolute",
                width: "1px",
                height: "1px",
                overflow: "hidden",
                clip: "rect(0 0 0 0)",
              }}
            >
              Search apps
            </span>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              strokeWidth="1.75"
              strokeLinecap="round"
              aria-hidden="true"
              style={{ stroke: "var(--fg-3)", position: "absolute", left: "12px" }}
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search apps"
              aria-label="Search apps"
              style={{
                width: "240px",
                height: "40px",
                boxSizing: "border-box",
                borderRadius: "10px",
                border: "1px solid var(--line)",
                background: "var(--surface)",
                color: "var(--fg)",
                padding: "0 12px 0 36px",
                fontSize: "14px",
                lineHeight: "20px",
              }}
            />
          </label>
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setDialogOpen(true)}
            aria-haspopup="dialog"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              height: "40px",
              padding: "0 16px",
              borderRadius: "10px",
              border: 0,
              background: "var(--btn-bg)",
              color: "var(--btn-fg)",
              fontSize: "14px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            New app
          </button>
        </div>
      </header>

      {/* New app dialog */}
      <NewAppDialog open={dialogOpen} onClose={handleCloseDialog} isOrgAdmin={isOrgAdmin} />

      {/* Filter tabs */}
      <div
        role="tablist"
        aria-label="Filter apps"
        style={{
          display: "flex",
          gap: "4px",
          padding: "4px",
          borderRadius: "12px",
          background: "var(--surface)",
          alignSelf: "flex-start",
        }}
      >
        {tabDefs.map(({ key, label }) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            type="button"
            onClick={() => setTab(key)}
            style={{
              height: "32px",
              padding: "0 12px",
              borderRadius: "8px",
              border: 0,
              background: tab === key ? "var(--surface-4)" : "transparent",
              color: tab === key ? "var(--fg)" : "var(--fg-2)",
              fontSize: "13px",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <p style={{ color: "var(--fg-3)", fontSize: "14px", margin: 0 }}>
          {search || tab !== "All" ? "No apps match." : "No apps yet."}
        </p>
      ) : (
        <section
          aria-label="Your apps"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: "16px",
            overflowX: "auto",
          }}
        >
          <div style={{ minWidth: "600px" }}>
            {/* Header — same grid as rows so columns align */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 2.4fr) 150px 150px 110px",
                gap: "16px",
                padding: "12px 24px",
                fontSize: "12px",
                lineHeight: "16px",
                fontWeight: 500,
                color: "var(--fg-3)",
                background: "var(--surface-2)",
              }}
            >
              <span>App</span>
              <span>Status</span>
              {/* "Last deploy" matches design; "Created" kept in place of "Shared with" and
                  "Visits, 7 days" which are omitted — shared counts require a separate join
                  and visit analytics are not yet collected. */}
              <span>Last deploy</span>
              <span>Created</span>
            </div>
            {filtered.map((app) => (
              <AppRow key={app.id} app={app} resolved={app.resolved} />
            ))}
          </div>
        </section>
      )}

      {/* Deploy box */}
      <section
        aria-label="Deploy from your tools"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "16px",
          padding: "24px",
          borderRadius: "16px",
          background: "var(--surface)",
          border: "1px solid var(--line)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <h2 style={{ margin: 0, fontSize: "16px", lineHeight: "24px", fontWeight: 600 }}>
            Ship another app
          </h2>
          <p style={{ margin: 0, fontSize: "14px", lineHeight: "20px", color: "var(--fg-2)" }}>
            Run this in your project folder, or ask your AI assistant to deploy with Utir.
          </p>
        </div>
        <div
          style={{
            display: "flex",
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
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "13px",
              lineHeight: "20px",
              color: "var(--fg)",
            }}
          >
            npx @utir/ssc deploy .
          </code>
          <button
            type="button"
            onClick={handleCopyCommand}
            aria-label="Copy command"
            style={{
              width: "32px",
              height: "32px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "8px",
              border: 0,
              background: "var(--surface-2)",
              color: copied ? "var(--green)" : "var(--fg-2)",
              cursor: "pointer",
              flex: "none",
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V5a1 1 0 0 1 1-1h9" />
            </svg>
          </button>
        </div>
      </section>
    </div>
  );
}

// ── AppRow ────────────────────────────────────────────────────────────────────

interface AppRowProps {
  app: App;
  resolved: ResolvedStatus;
}

function AppRow({ app, resolved }: AppRowProps) {
  return (
    // borderTop on the row container — single line spanning full width, no gap segments
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 2.4fr) 150px 150px 110px",
        gap: "16px",
        padding: "16px 24px",
        borderTop: "1px solid var(--line)",
        alignItems: "center",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
        <Link
          href={`/apps/${app.id}`}
          style={{
            color: "var(--fg)",
            textDecoration: "none",
            fontWeight: 500,
            fontSize: "15px",
            lineHeight: "20px",
          }}
        >
          {app.name}
        </Link>
        {hostOnly(app.subdomain) && (
          <span
            style={{
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "12px",
              lineHeight: "16px",
              color: "var(--fg-3)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {hostOnly(app.subdomain)}
          </span>
        )}
      </div>
      <div>
        <AppStatusBadge status={resolved} />
      </div>
      <div style={{ fontSize: "13px", color: "var(--fg-2)", whiteSpace: "nowrap" }}>
        {app.last_deployed_at ? formatDate(app.last_deployed_at) : "—"}
      </div>
      <div style={{ fontSize: "13px", color: "var(--fg-2)", whiteSpace: "nowrap" }}>
        {formatDate(app.created_at)}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ── NewAppDialog ──────────────────────────────────────────────────────────────

function NewAppDialog({
  open,
  onClose,
  isOrgAdmin,
}: {
  open: boolean;
  onClose: () => void;
  isOrgAdmin: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    // Focus the first interactive element when dialog opens
    const panel = panelRef.current;
    if (panel) {
      const first = panel.querySelector<HTMLElement>(
        "button:not([disabled]), [href], input:not([disabled])",
      );
      first?.focus();
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const container = panelRef.current;
      if (!container) return;
      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(
          "button:not([disabled]), [href]:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((el) => !el.closest("[aria-hidden='true']"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "24px",
        boxSizing: "border-box",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-app-dialog-title"
        style={{
          width: "100%",
          maxWidth: "480px",
          background: "var(--surface)",
          border: "1px solid var(--line)",
          borderRadius: "16px",
          padding: "32px",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
          position: "relative",
          boxSizing: "border-box",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", flexDirection: "column", gap: "4px", paddingRight: "32px" }}>
          <h2
            id="new-app-dialog-title"
            style={{ margin: 0, fontSize: "20px", lineHeight: "28px", fontWeight: 600 }}
          >
            Ship a new app
          </h2>
          <p style={{ margin: 0, fontSize: "14px", lineHeight: "20px", color: "var(--fg-2)" }}>
            Deploy from your terminal, or let your AI assistant do it.
          </p>
        </div>

        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            position: "absolute",
            top: "24px",
            right: "24px",
            width: "32px",
            height: "32px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "8px",
            border: "1px solid var(--line-strong)",
            background: "transparent",
            color: "var(--fg-3)",
            cursor: "pointer",
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        {/* Steps */}
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          {/* Step 1: Get a key */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <StepNumber n={1} />
              <span style={{ fontSize: "14px", fontWeight: 600 }}>Get a key</span>
            </div>
            {isOrgAdmin ? (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: "8px",
                  paddingLeft: "30px",
                  fontSize: "14px",
                  lineHeight: "20px",
                  color: "var(--fg-2)",
                }}
              >
                You need an API key with deploy permission.
                <Link
                  href="/keys"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    height: "32px",
                    padding: "0 12px",
                    borderRadius: "8px",
                    border: "1px solid var(--line-strong)",
                    background: "transparent",
                    color: "var(--fg)",
                    fontSize: "13px",
                    fontWeight: 500,
                    textDecoration: "none",
                    whiteSpace: "nowrap",
                  }}
                >
                  Go to API keys
                </Link>
              </div>
            ) : (
              <p
                style={{
                  margin: 0,
                  paddingLeft: "30px",
                  fontSize: "14px",
                  lineHeight: "20px",
                  color: "var(--fg-2)",
                }}
              >
                Ask a workspace admin for a key.
              </p>
            )}
          </div>

          {/* Step 2: Sign in the command line */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <StepNumber n={2} />
              <span style={{ fontSize: "14px", fontWeight: 600 }}>Sign in the command line</span>
            </div>
            <div style={{ paddingLeft: "30px" }}>
              <CopyCodeBox code="npx @utir/ssc login" label="Copy login command" />
            </div>
          </div>

          {/* Step 3: Deploy */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <StepNumber n={3} />
              <span style={{ fontSize: "14px", fontWeight: 600 }}>Deploy</span>
            </div>
            <div style={{ paddingLeft: "30px", display: "flex", flexDirection: "column", gap: "6px" }}>
              <CopyCodeBox code="npx @utir/ssc deploy ." label="Copy deploy command" />
              <p style={{ margin: 0, fontSize: "13px", lineHeight: "16px", color: "var(--fg-3)" }}>
                Run it inside your project folder.
              </p>
            </div>
          </div>
        </div>

        {/* AI assistant section */}
        <div
          style={{
            borderTop: "1px solid var(--line)",
            paddingTop: "20px",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--fg-2)" }}>
            Or use your AI assistant
          </span>
          <p style={{ margin: 0, fontSize: "13px", lineHeight: "18px", color: "var(--fg-2)" }}>
            Let Claude or Cursor deploy for you via the MCP server.
          </p>
          <CopyCodeBox code="@utir/ssc-mcp" label="Copy package name" />
        </div>
      </div>
    </div>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: "20px",
        height: "20px",
        borderRadius: "999px",
        background: "var(--surface-3)",
        color: "var(--fg-2)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "11px",
        fontWeight: 600,
        flex: "none",
      }}
    >
      {n}
    </span>
  );
}

function CopyCodeBox({ code, label = "Copy" }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div
      style={{
        display: "flex",
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
          color: "var(--fg)",
          overflowWrap: "anywhere",
        }}
      >
        {code}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : label}
        style={{
          width: "32px",
          height: "32px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "8px",
          border: 0,
          background: "var(--surface-2)",
          color: copied ? "var(--green)" : "var(--fg-2)",
          cursor: "pointer",
          flex: "none",
        }}
      >
        {copied ? (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a1 1 0 0 1 1-1h9" />
          </svg>
        )}
      </button>
    </div>
  );
}
