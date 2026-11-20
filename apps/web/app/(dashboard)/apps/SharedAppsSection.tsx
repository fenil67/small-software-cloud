import React from "react";
import type { SharedApp } from "../../../lib/api-types";

export function SharedAppsSection({ apps }: { apps: SharedApp[] }) {
  if (apps.length === 0) return null;
  return (
    <section aria-labelledby="shared-apps-heading" style={{ marginTop: "48px" }}>
      <h2 id="shared-apps-heading" style={{ fontSize: "16px", fontWeight: 600, marginBottom: "16px", color: "var(--fg)" }}>
        Shared with you
      </h2>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "480px" }} aria-label="Apps shared with you">
          <thead>
            <tr style={{ background: "var(--surface-2)" }}>
              <th style={thStyle}>App</th>
              <th style={thStyle}>Workspace</th>
              <th style={thStyle}>Shared</th>
              <th style={{ ...thStyle, textAlign: "right" }}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {apps.map(app => (
              <tr key={app.app_id} style={{ borderBottom: "1px solid var(--line)" }}>
                <td style={tdStyle}>{app.app_name}</td>
                <td style={tdStyle}>{app.org_name}</td>
                <td style={tdStyle}>
                  {app.status === "pending"
                    ? <span style={{ color: "var(--fg-3)", fontSize: "13px" }}>Not opened yet</span>
                    : app.granted_at
                      ? <span style={{ color: "var(--fg-2)", fontSize: "13px" }}>{formatDate(app.granted_at)}</span>
                      : null
                  }
                </td>
                <td style={{ ...tdStyle, textAlign: "right" }}>
                  {app.url && app.status === "active" && (
                    <a
                      href={app.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: "13px", color: "var(--fg-2)", textDecoration: "none", padding: "4px 10px", border: "1px solid var(--line-strong)", borderRadius: "8px" }}
                    >
                      Open
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const thStyle: React.CSSProperties = { textAlign: "left", fontSize: "12px", fontWeight: 500, color: "var(--fg-3)", padding: "10px 12px" };
const tdStyle: React.CSSProperties = { fontSize: "14px", padding: "12px", color: "var(--fg)" };

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}
