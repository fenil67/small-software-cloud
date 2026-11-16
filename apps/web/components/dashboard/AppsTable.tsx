"use client";

import { useState } from "react";
import Link from "next/link";
import type { App } from "../../lib/api-types";
import { resolveAppStatus, type ResolvedStatus } from "../../lib/status";
import { AppStatusBadge } from "./AppStatusBadge";

type FilterTab = "All" | "Live" | "Needs attention";

interface Props {
  apps: App[];
}

function needsAttention(status: ResolvedStatus): boolean {
  return status === "Failed" || status === "Suspended";
}

export function AppsTable({ apps }: Props) {
  const [tab, setTab] = useState<FilterTab>("All");
  const [search, setSearch] = useState("");

  const resolvedApps = apps.map((a) => ({
    ...a,
    resolved: resolveAppStatus(a.suspended, a.status, a.latest_deployment_status),
  }));

  const filtered = resolvedApps.filter((a) => {
    const matchesTab =
      tab === "All" ||
      (tab === "Live" && a.resolved === "Live") ||
      (tab === "Needs attention" && needsAttention(a.resolved));
    const matchesSearch = !search || a.name.toLowerCase().includes(search.toLowerCase());
    return matchesTab && matchesSearch;
  });

  const tabs: FilterTab[] = ["All", "Live", "Needs attention"];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Filter bar */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <div
          role="tablist"
          aria-label="Filter apps"
          style={{
            display: "flex",
            gap: "2px",
            padding: "3px",
            borderRadius: "10px",
            background: "var(--surface-2)",
          }}
        >
          {tabs.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              type="button"
              onClick={() => setTab(t)}
              style={{
                padding: "5px 12px",
                borderRadius: "8px",
                border: 0,
                background: tab === t ? "var(--surface-4)" : "transparent",
                color: tab === t ? "var(--fg)" : "var(--fg-2)",
                fontSize: "13px",
                fontWeight: tab === t ? 500 : 400,
                cursor: "pointer",
              }}
            >
              {t}
            </button>
          ))}
        </div>

        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search apps..."
          aria-label="Search apps"
          style={{
            height: "32px",
            padding: "0 12px",
            borderRadius: "8px",
            border: "1px solid var(--line-strong)",
            background: "var(--bg)",
            color: "var(--fg)",
            fontSize: "13px",
            width: "200px",
          }}
        />
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <p style={{ color: "var(--fg-3)", fontSize: "14px", margin: 0 }}>
          {search || tab !== "All" ? "No apps match." : "No apps yet."}
        </p>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 2.4fr) 150px 150px 110px",
          }}
        >
          {/* Header */}
          <div style={{ display: "contents" }}>
            {["App", "Status", "Last deployed", "Created"].map((h) => (
              <div
                key={h}
                style={{
                  padding: "8px 12px",
                  fontSize: "12px",
                  fontWeight: 500,
                  color: "var(--fg-3)",
                  borderBottom: "1px solid var(--line)",
                }}
              >
                {h}
              </div>
            ))}
          </div>

          {/* Rows */}
          {filtered.map((app) => (
            <AppRow key={app.id} app={app} resolved={app.resolved} />
          ))}
        </div>
      )}
    </div>
  );
}

interface AppRowProps {
  app: App;
  resolved: ResolvedStatus;
}

function AppRow({ app, resolved }: AppRowProps) {
  const rowStyle: React.CSSProperties = {
    padding: "12px",
    borderBottom: "1px solid var(--line)",
    display: "flex",
    alignItems: "center",
  };

  return (
    <>
      <div style={rowStyle}>
        <Link
          href={`/apps/${app.id}`}
          style={{ color: "var(--fg)", textDecoration: "none", fontWeight: 500, fontSize: "14px" }}
        >
          {app.name}
        </Link>
        {app.subdomain && (
          <span style={{ marginLeft: "8px", fontSize: "12px", color: "var(--fg-3)" }}>
            {app.subdomain}
          </span>
        )}
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
    </>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
