"use client";

import Link from "next/link";

interface Props {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ reset }: Props) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "system-ui, sans-serif",
          background: "var(--bg, #0a0a0a)",
          color: "var(--fg, #ededed)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          padding: "48px 16px",
          boxSizing: "border-box",
        }}
      >
        <div
          role="alert"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            padding: "32px",
            borderRadius: "16px",
            background: "var(--surface, #1a1a1a)",
            border: "1px solid var(--line, #2a2a2a)",
            maxWidth: "420px",
            width: "100%",
          }}
        >
          <p style={{ margin: 0, fontSize: "14px", lineHeight: "20px", color: "var(--fg-2, #a0a0a0)" }}>
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
                border: "1px solid var(--line-strong, #3a3a3a)",
                background: "transparent",
                color: "var(--fg, #ededed)",
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
                border: "1px solid var(--line-strong, #3a3a3a)",
                background: "transparent",
                color: "var(--fg-2, #a0a0a0)",
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
      </body>
    </html>
  );
}
