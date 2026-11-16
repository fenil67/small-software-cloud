import { apiFetch } from "../../../lib/api";
import type { App } from "../../../lib/api-types";
import { AppsTable } from "../../../components/dashboard/AppsTable";
import { ErrorCard } from "../../../components/dashboard/ErrorCard";

export const dynamic = "force-dynamic";

export default async function AppsPage() {
  let apps: App[] = [];
  let error: string | null = null;

  try {
    apps = await apiFetch<App[]>("/v1/apps");
  } catch (e: unknown) {
    const status = (e as { status?: number }).status ?? 0;
    console.error(`[apps] GET /v1/apps failed with status ${status}`);
    error = "We could not load your apps. Try again in a moment.";
  }

  return (
    <div style={{ padding: "40px 48px 64px", maxWidth: "1200px" }}>
      {error ? (
        <ErrorCard message={error} />
      ) : (
        <AppsTable apps={apps} />
      )}
    </div>
  );
}
