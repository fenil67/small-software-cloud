import type { Deployment } from "../../../../lib/api-types";
import { deploymentFailureTitle } from "../../../../lib/status";

interface Props {
  deployment: Deployment;
  isLatest: boolean;
}

export function DeploymentRow({ deployment: d, isLatest }: Props) {
  const isFailed = d.status === "failed";

  return (
    <div
      style={{
        padding: "12px 16px",
        borderRadius: "10px",
        background: "var(--surface)",
        border: "1px solid var(--line)",
        display: "flex",
        flexDirection: "column",
        gap: isFailed ? "10px" : "0",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <DeployStatusIcon status={d.status} />
        <span style={{ fontSize: "13px", color: "var(--fg)", fontWeight: 500 }}>
          v{d.version}
          {isLatest && (
            <span style={{ marginLeft: "6px", fontSize: "11px", color: "var(--fg-3)", fontWeight: 400 }}>
              latest
            </span>
          )}
        </span>
        <span style={{ flex: 1 }} />
        {d.finished_at && (
          <span style={{ fontSize: "12px", color: "var(--fg-3)" }}>
            {formatRelative(d.finished_at)}
          </span>
        )}
      </div>

      {isFailed && (
        <div
          style={{
            background: "var(--bg)",
            border: "1px solid var(--line)",
            borderRadius: "8px",
            padding: "10px 12px",
          }}
        >
          <p style={{ margin: "0 0 4px", fontSize: "13px", fontWeight: 500, color: "var(--red)" }}>
            {deploymentFailureTitle(d.failure_stage)}
          </p>
          {d.failure_message && (
            <details style={{ margin: 0 }}>
              <summary style={{ fontSize: "12px", color: "var(--fg-3)", cursor: "pointer" }}>
                Details
              </summary>
              <pre
                style={{
                  margin: "6px 0 0",
                  fontSize: "12px",
                  color: "var(--fg-2)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontFamily: "var(--font-mono, monospace)",
                }}
              >
                {d.failure_message.slice(0, 500)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function DeployStatusIcon({ status }: { status: string }) {
  if (status === "success") {
    return (
      <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8">
        <circle cx="4" cy="4" r="4" fill="var(--green)" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--red)" strokeWidth="2.5" strokeLinecap="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
    );
  }
  if (status === "building" || status === "deploying" || status === "queued") {
    return (
      <svg
        aria-hidden="true"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--blue)"
        strokeWidth="2.5"
        strokeLinecap="round"
        style={{ animation: "spin 1s linear infinite" }}
      >
        <path d="M12 2a10 10 0 1 0 10 10" />
      </svg>
    );
  }
  // cancelled or other — hollow grey circle
  return (
    <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8">
      <circle cx="4" cy="4" r="3" fill="none" stroke="var(--fg-3)" strokeWidth="1.5" />
    </svg>
  );
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
