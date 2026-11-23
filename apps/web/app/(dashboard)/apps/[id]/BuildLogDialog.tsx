"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@clerk/nextjs";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.5)",
};

const panel: React.CSSProperties = {
  width: "min(720px, calc(100vw - 32px))",
  maxHeight: "calc(100vh - 64px)",
  borderRadius: "14px",
  background: "var(--bg)",
  border: "1px solid var(--line)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

interface Props {
  appId: string;
  deploymentId: string;
  version: number;
  onClose: () => void;
}

export function BuildLogDialog({ appId, deploymentId, version, onClose }: Props) {
  const { getToken } = useAuth();
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchLog = useCallback(async () => {
    try {
      const token = await getToken();
      if (!token) { setError("Not authenticated."); return; }
      const res = await fetch(
        `${API_URL}/v1/apps/${appId}/deployments/${deploymentId}/logs`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        if (res.status === 404) {
          setError("No build log available for this deployment.");
        } else {
          setError(body.error === "app_not_found" ? "App not found." : "Could not load build log.");
        }
        return;
      }
      const data = await res.json() as { content?: string; truncated?: boolean };
      if (typeof data.content !== "string") { setError("Unexpected response format."); return; }
      setContent(data.content);
      setTruncated(data.truncated === true);
    } catch {
      setError("Could not load build log.");
    }
  }, [getToken, appId, deploymentId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void fetchLog(); }, [fetchLog]);

  function handleCopy() {
    if (!content) return;
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  function handleDownload() {
    if (!content) return;
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `deploy-v${version}-log.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="build-log-dialog-title"
      style={overlay}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={panel}>
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "16px 20px",
            borderBottom: "1px solid var(--line)",
            gap: "12px",
            flexShrink: 0,
          }}
        >
          <h3
            id="build-log-dialog-title"
            style={{ margin: 0, fontSize: "15px", fontWeight: 600, flex: 1 }}
          >
            Build log — v{version}
          </h3>
          {content && (
            <>
              <button
                type="button"
                onClick={handleCopy}
                aria-label="Copy build log"
                style={{
                  height: "32px",
                  padding: "0 12px",
                  borderRadius: "8px",
                  border: "1px solid var(--line-strong)",
                  background: "transparent",
                  color: "var(--fg)",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                onClick={handleDownload}
                aria-label="Download build log"
                style={{
                  height: "32px",
                  padding: "0 12px",
                  borderRadius: "8px",
                  border: "1px solid var(--line-strong)",
                  background: "transparent",
                  color: "var(--fg)",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                Download
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close build log"
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "8px",
              border: "1px solid var(--line-strong)",
              background: "transparent",
              color: "var(--fg-2)",
              fontSize: "16px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: "auto", padding: "16px 20px" }}>
          {!content && !error && (
            <p style={{ margin: 0, fontSize: "13px", color: "var(--fg-3)" }}>Loading...</p>
          )}
          {error && (
            <p role="alert" style={{ margin: 0, fontSize: "13px", color: "var(--red)" }}>{error}</p>
          )}
          {content && (
            <>
              {truncated && (
                <p style={{ margin: "0 0 12px", fontSize: "12px", color: "var(--fg-3)" }}>
                  Log was truncated (too large). Showing first and last portions.
                </p>
              )}
              <pre
                style={{
                  margin: 0,
                  fontSize: "12px",
                  lineHeight: "1.6",
                  fontFamily: "var(--font-mono, monospace)",
                  color: "var(--fg)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {content}
              </pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
