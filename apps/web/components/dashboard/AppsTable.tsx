"use client";

import { useState } from "react";
import Link from "next/link";
import type { App } from "../../lib/api-types";
import { resolveAppStatus, type ResolvedStatus } from "../../lib/status";
import { AppStatusBadge } from "./AppStatusBadge";
import { appUrl } from "../../lib/app-url";

type FilterKey = "All" | "Live" | "Needs attention";

interface Props {
  apps: App[];
}

function needsAttention(status: ResolvedStatus): boolean {
  return status === "Failed" || status === "Suspended";
}

export function AppsTable({ apps }: Props) {
  const [tab, setTab] = useState<FilterKey>("All");
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState(false);

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
            type="button"
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
              {["App", "Status", "Last deployed", "Created"].map((h) => (
                <span key={h}>{h}</span>
              ))}
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

interface AppRowProps {
  app: App;
  resolved: ResolvedStatus;
}

function AppRow({ app, resolved }: AppRowProps) {
  const rowStyle: React.CSSProperties = {
    padding: "16px 24px",
    borderTop: "1px solid var(--line)",
    display: "flex",
    alignItems: "center",
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 2.4fr) 150px 150px 110px",
        gap: "16px",
        alignItems: "center",
      }}
    >
      <div style={rowStyle}>
        <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
          <Link
            href={`/apps/${app.id}`}
            style={{ color: "var(--fg)", textDecoration: "none", fontWeight: 500, fontSize: "15px", lineHeight: "20px" }}
          >
            {app.name}
          </Link>
          {appUrl(app.subdomain) && (
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
              {appUrl(app.subdomain)}
            </span>
          )}
        </div>
      </div>
      <div style={rowStyle}>
        <AppStatusBadge status={resolved} />
      </div>
      <div style={{ ...rowStyle, fontSize: "13px", color: "var(--fg-2)" }}>
        {app.last_deployed_at ? formatDate(app.last_deployed_at) : "—"}
      </div>
      <div style={{ ...rowStyle, fontSize: "13px", color: "var(--fg-2)" }}>
        {formatDate(app.created_at)}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
