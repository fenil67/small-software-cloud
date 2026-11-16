"use client";

import { useRouter } from "next/navigation";

interface Props {
  message: string;
}

export function ErrorCard({ message }: Props) {
  const router = useRouter();
  return (
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
        {message}
      </p>
      <button
        type="button"
        onClick={() => router.refresh()}
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
          cursor: "pointer",
        }}
      >
        Try again
      </button>
    </div>
  );
}
