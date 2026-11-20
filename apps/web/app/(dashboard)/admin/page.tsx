import { notFound } from "next/navigation";
import { apiFetch } from "../../../lib/api";
import type { MeResponse, AdminStats, AdminApp } from "../../../lib/api-types";
import { AdminOverviewClient } from "./AdminOverviewClient";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  // Check admin status
  let isAdmin = false;
  try {
    const me = await apiFetch<MeResponse>("/v1/me");
    isAdmin = me.is_admin;
  } catch { /* treat as non-admin */ }
  if (!isAdmin) notFound();

  // Fetch data in parallel
  let stats: AdminStats | null = null;
  let apps: AdminApp[] = [];
  let statsError: string | null = null;
  let appsError: string | null = null;

  await Promise.allSettled([
    apiFetch<AdminStats>("/v1/admin/stats").then(d => { stats = d; }).catch(() => { statsError = "Could not load stats."; }),
    apiFetch<AdminApp[]>("/v1/admin/apps").then(d => { apps = d; }).catch(() => { appsError = "Could not load apps."; }),
  ]);

  return (
    <AdminOverviewClient
      stats={stats}
      apps={apps}
      statsError={statsError}
      appsError={appsError}
    />
  );
}
