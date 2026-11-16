import { apiFetch } from "../../../lib/api";
import type { App } from "../../../lib/api-types";
import { AppsTable } from "../../../components/dashboard/AppsTable";

export const dynamic = "force-dynamic";

export default async function AppsPage() {
  let apps: App[] = [];
  let error: string | null = null;

  try {
    apps = await apiFetch<App[]>("/v1/apps");
  } catch {
    error = "Could not load apps.";
  }

  return (
    <div style={{ padding: "32px 40px", maxWidth: "1100px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "24px" }}>
        <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 600, letterSpacing: "-0.01em" }}>
          Apps
        </h1>
      </div>

      {error ? (
        <p role="alert" style={{ color: "var(--red)", fontSize: "14px" }}>{error}</p>
      ) : (
        <AppsTable apps={apps} />
      )}

      <ShipAnotherApp />
    </div>
  );
}

function ShipAnotherApp() {
  return (
    <div
      style={{
        marginTop: "40px",
        padding: "24px",
        borderRadius: "16px",
        border: "1px solid var(--line)",
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        maxWidth: "480px",
      }}
    >
      <h2 style={{ margin: 0, fontSize: "15px", fontWeight: 600 }}>Ship another app</h2>
      <p style={{ margin: 0, fontSize: "14px", color: "var(--fg-2)", lineHeight: "20px" }}>
        Use the CLI or MCP server to deploy a new app to your workspace.
      </p>
      <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
        <code
          style={{
            flex: 1,
            padding: "8px 12px",
            borderRadius: "8px",
            background: "var(--surface-2)",
            fontSize: "13px",
            color: "var(--fg-2)",
            fontFamily: "var(--font-mono, monospace)",
          }}
        >
          npx @utir/ssc deploy
        </code>
      </div>
    </div>
  );
}
