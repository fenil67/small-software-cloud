import { apiFetch } from "../../../lib/api";
import type { App, SharedApp } from "../../../lib/api-types";
import { AppsTable } from "../../../components/dashboard/AppsTable";
import { SharedAppsSection } from "./SharedAppsSection";
import { ErrorCard } from "../../../components/dashboard/ErrorCard";

export const dynamic = "force-dynamic";

export default async function AppsPage() {
  let apps: App[] = [];
  let sharedApps: SharedApp[] = [];
  let error: string | null = null;

  await Promise.allSettled([
    apiFetch<App[]>("/v1/apps").then(d => { apps = d; }).catch(e => {
      const status = (e as { status?: number }).status ?? 0;
      console.error(`[apps] GET /v1/apps failed with status ${status}`);
      error = "We could not load your apps. Try again in a moment.";
    }),
    apiFetch<SharedApp[]>("/v1/me/shared-apps").then(d => { sharedApps = d; }).catch(() => {
      // Non-fatal: shared apps fail silently
    }),
  ]);

  return (
    <div style={{ padding: "40px 48px 64px", maxWidth: "1200px" }}>
      {error ? (
        <ErrorCard message={error} />
      ) : (
        <AppsTable apps={apps} />
      )}
      {sharedApps.length > 0 && <SharedAppsSection apps={sharedApps} />}
    </div>
  );
}
