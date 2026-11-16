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
    <div style={{ padding: "40px 48px 64px", maxWidth: "1200px" }}>
      {error ? (
        <p role="alert" style={{ color: "var(--red)", fontSize: "14px" }}>{error}</p>
      ) : (
        <AppsTable apps={apps} />
      )}
    </div>
  );
}
