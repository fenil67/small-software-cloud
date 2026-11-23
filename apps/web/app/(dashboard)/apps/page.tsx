import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { apiFetch } from "../../../lib/api";
import type { App, SharedApp } from "../../../lib/api-types";
import { AppsTable } from "../../../components/dashboard/AppsTable";
import { SharedAppsSection } from "./SharedAppsSection";
import { ErrorCard } from "../../../components/dashboard/ErrorCard";

export const dynamic = "force-dynamic";

export default async function AppsPage() {
  const { orgRole } = await auth();
  const isOrgAdmin = orgRole === "org:admin";

  let apps: App[] = [];
  let sharedApps: SharedApp[] = [];
  let error: string | null = null;
  let noActiveOrg = false;

  await Promise.allSettled([
    apiFetch<App[]>("/v1/apps").then(d => { apps = d; }).catch(e => {
      const status = (e as { status?: number }).status ?? 0;
      const code   = (e as { code?: string }).code ?? "";
      if (status === 400 && code === "no_active_org") {
        noActiveOrg = true;
        return;
      }
      console.error(`[apps] GET /v1/apps failed with status ${status}`);
      error = "We could not load your apps. Try again in a moment.";
    }),
    apiFetch<SharedApp[]>("/v1/me/shared-apps").then(d => { sharedApps = d; }).catch(() => {
      // Non-fatal: shared apps fail silently
    }),
  ]);

  if (noActiveOrg) redirect("/onboarding");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>
      {error ? (
        <ErrorCard message={error} />
      ) : (
        <AppsTable apps={apps} isOrgAdmin={isOrgAdmin} />
      )}
      {sharedApps.length > 0 && <SharedAppsSection apps={sharedApps} />}
    </div>
  );
}
