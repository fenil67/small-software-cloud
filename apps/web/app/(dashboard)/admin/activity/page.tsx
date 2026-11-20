import { notFound } from "next/navigation";
import { apiFetch } from "../../../../lib/api";
import type { MeResponse, ActivitySummaryItem } from "../../../../lib/api-types";
import { ActivityClient } from "./ActivityClient";

export const dynamic = "force-dynamic";

export default async function AdminActivityPage() {
  let isAdmin = false;
  try {
    const me = await apiFetch<MeResponse>("/v1/me");
    isAdmin = me.is_admin;
  } catch {}
  if (!isAdmin) notFound();

  let summary: ActivitySummaryItem[] = [];
  try {
    summary = await apiFetch<ActivitySummaryItem[]>("/v1/admin/activity/summary");
  } catch {}

  return <ActivityClient initialSummary={summary} />;
}
