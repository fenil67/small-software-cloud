import React from "react";
import type { SharedApp } from "../../../lib/api-types";

export function SharedAppsSection({ apps }: { apps: SharedApp[] }) {
  if (apps.length === 0) return null;

  const cols = "minmax(0, 2fr) minmax(0, 1.4fr) 140px 100px";

  return (
    <section
      aria-labelledby="shared-apps-heading"
      style={{
        marginTop: "32px",
        background: "var(--surface)",
        border: "1px solid var(--line)",
        borderRadius: "16px",
        overflow: "hidden",
      }}
    >
      {/* Card header */}
      <div style={{ padding: "20px 24px", borderBottom: "1px solid var(--line)" }}>
        <h2
          id="shared-apps-heading"
          style={{ margin: 0, fontSize: "16px", lineHeight: "24px", fontWeight: 600 }}
        >
          Shared with you
        </h2>
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: "480px" }}>
          {/* Column headers */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: cols,
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
            <span>Workspace</span>
            <span>Shared</span>
            <span>
              <span
                style={{
                  position: "absolute",
                  width: 1,
                  height: 1,
                  overflow: "hidden",
                  clip: "rect(0 0 0 0)",
                }}
              >
                Actions
              </span>
            </span>
          </div>

          {/* Rows */}
          {apps.map((app) => (
            <div
              key={app.app_id}
              style={{
                display: "grid",
                gridTemplateColumns: cols,
                gap: "16px",
                padding: "16px 24px",
                borderTop: "1px solid var(--line)",
                alignItems: "center",
              }}
            >
              <div
                style={{
                  fontSize: "14px",
                  fontWeight: 500,
                  color: "var(--fg)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {app.app_name}
              </div>
              <div
                style={{
                  fontSize: "13px",
                  color: "var(--fg-2)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {app.org_name}
              </div>
              <div style={{ fontSize: "13px", color: "var(--fg-2)", whiteSpace: "nowrap" }}>
                {app.status === "pending" ? (
                  <span style={{ color: "var(--fg-3)" }}>Not opened yet</span>
                ) : app.granted_at ? (
                  formatDate(app.granted_at)
                ) : null}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                {app.url && app.status === "active" && (
                  <a
                    href={app.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      height: "32px",
                      padding: "0 12px",
                      borderRadius: "8px",
                      border: "1px solid var(--line-strong)",
                      background: "transparent",
                      color: "var(--fg-2)",
                      fontSize: "13px",
                      fontWeight: 500,
                      textDecoration: "none",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Open
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}
