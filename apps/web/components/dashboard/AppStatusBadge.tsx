import type { ResolvedStatus } from "../../lib/status";

interface Props {
  status: ResolvedStatus;
}

export function AppStatusBadge({ status }: Props) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "13px",
        color: colorFor(status),
      }}
    >
      <StatusIcon status={status} />
      {status}
    </span>
  );
}

function colorFor(status: ResolvedStatus): string {
  switch (status) {
    case "Live":      return "var(--green)";
    case "Deploying": return "var(--blue)";
    case "Failed":    return "var(--red)";
    case "Suspended": return "var(--orange)";
    case "Sleeping":  return "var(--fg-3)";
  }
}

function StatusIcon({ status }: { status: ResolvedStatus }) {
  switch (status) {
    case "Live":
      return (
        <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8">
          <circle cx="4" cy="4" r="4" fill="var(--green)" />
        </svg>
      );
    case "Deploying":
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
    case "Failed":
      return (
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--red)" strokeWidth="2.5" strokeLinecap="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
      );
    case "Suspended":
      return (
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="var(--orange)" stroke="none">
          <rect x="6" y="4" width="4" height="16" rx="1" />
          <rect x="14" y="4" width="4" height="16" rx="1" />
        </svg>
      );
    case "Sleeping":
      // Hollow grey circle
      return (
        <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8">
          <circle cx="4" cy="4" r="3" fill="none" stroke="var(--fg-3)" strokeWidth="1.5" />
        </svg>
      );
  }
}
