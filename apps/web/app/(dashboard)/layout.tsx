import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Sidebar } from "../../components/dashboard/Sidebar";
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
    <div style={{ display: "flex", height: "100vh", overflow: "hidden", background: "var(--bg)" }}>
      <Sidebar isAdmin={isAdmin} openAlertCount={openAlertCount} />
      <main style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>{children}</main>
    </div>
  );
}
