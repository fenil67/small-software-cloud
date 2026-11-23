import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { DashboardShell } from "../../components/dashboard/DashboardShell";
import { apiFetch } from "../../lib/api";
import type { MeResponse } from "../../lib/api-types";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { userId, orgId } = await auth();
  if (!userId) redirect("/sign-in");
  if (!orgId) redirect("/onboarding");

  let isAdmin = false;
  let openAlertCount = 0;
  try {
    const me = await apiFetch<MeResponse>("/v1/me");
    isAdmin = me.is_admin;
    openAlertCount = me.open_alert_count ?? 0;
  } catch {
    // Non-fatal: treat as non-admin
  }

  return (
    <DashboardShell isAdmin={isAdmin} openAlertCount={openAlertCount}>
      {children}
    </DashboardShell>
  );
}
