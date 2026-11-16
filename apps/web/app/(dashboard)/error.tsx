"use client";

import Link from "next/link";

interface Props {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function DashboardError({ reset }: Props) {
  return (
    <div
      style={{
        padding: "32px 40px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      <div
        role="alert"
        style={{
          display: "inline-flex",
          flexDirection: "column",
          gap: "12px",
          padding: "24px",
          borderRadius: "16px",
          background: "var(--surface)",
          border: "1px solid var(--line)",
        }}
      >
        <p style={{ margin: 0, fontSize: "14px", lineHeight: "20px", color: "var(--fg-2)" }}>
          Something went wrong. Please try again.
        </p>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button
            type="button"
            onClick={reset}
            style={{
              height: "36px",
              padding: "0 16px",
              borderRadius: "10px",
              border: "1px solid var(--line-strong)",
              background: "transparent",
              color: "var(--fg)",
              fontSize: "13px",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          <Link
            href="/apps"
            style={{
              height: "36px",
              padding: "0 16px",
              borderRadius: "10px",
              border: "1px solid var(--line-strong)",
              background: "transparent",
              color: "var(--fg-2)",
              fontSize: "13px",
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            Back to Apps
          </Link>
        </div>
      </div>
    </div>
  );
}
