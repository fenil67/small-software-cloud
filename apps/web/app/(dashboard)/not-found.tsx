import Link from "next/link";

export default function NotFound() {
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
        style={{
          display: "inline-flex",
          flexDirection: "column",
          gap: "12px",
          padding: "24px",
          borderRadius: "16px",
          background: "var(--surface)",
          border: "1px solid var(--line)",
          maxWidth: "480px",
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: "18px",
            lineHeight: "28px",
            fontWeight: 600,
            color: "var(--fg)",
          }}
        >
          We could not find that
        </h1>
        <p style={{ margin: 0, fontSize: "14px", lineHeight: "20px", color: "var(--fg-2)" }}>
          It may belong to another workspace, or it was deleted.
        </p>
        <Link
          href="/apps"
          style={{
            alignSelf: "flex-start",
            height: "36px",
            padding: "0 16px",
            borderRadius: "10px",
            border: "1px solid var(--line-strong)",
            background: "transparent",
            color: "var(--fg)",
            fontSize: "13px",
            fontWeight: 500,
            textDecoration: "none",
            display: "inline-flex",
            alignItems: "center",
          }}
        >
          Back to apps
        </Link>
      </div>
    </div>
  );
}
