"use server";

import { auth } from "@clerk/nextjs/server";
import { apiFetch } from "../../../lib/api";
import type { App, AppAccess } from "../../../lib/api-types";

export async function deleteApp(
  appId: string,
  confirmedName: string,
): Promise<{ error?: string }> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) return { error: "not_authenticated" };

  // Fetch the app name from API and compare exactly (case-sensitive, trimmed)
  let app: App;
  try {
    app = await apiFetch<App>(`/v1/apps/${appId}`, { token });
  } catch (e: unknown) {
    const status = (e as { status?: number }).status;
    if (status === 404) return { error: "app_not_found" };
    return { error: "fetch_failed" };
  }

  if (app.name.trim() !== confirmedName.trim()) {
    return { error: "name_mismatch" };
  }

  try {
    await apiFetch(`/v1/apps/${appId}`, { method: "DELETE", token });
    return {};
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    return { error: code ?? "delete_failed" };
  }
}

export async function grantAccess(
  appId: string,
  email: string,
): Promise<{ error?: string }> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) return { error: "not_authenticated" };

  try {
    await apiFetch(`/v1/apps/${appId}/access`, {
      method: "POST",
      body: { email },
      token,
    });
    return {};
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    return { error: code ?? "grant_failed" };
  }
}

export async function revokeAccess(
  appId: string,
  email: string,
): Promise<{ error?: string }> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) return { error: "not_authenticated" };

  try {
    await apiFetch(`/v1/apps/${appId}/access/${encodeURIComponent(email)}`, {
      method: "DELETE",
      token,
    });
    return {};
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    return { error: code ?? "revoke_failed" };
  }
}

// Fetch access list — called from the page
export async function fetchAccessList(
  appId: string,
  token: string,
): Promise<AppAccess[]> {
  return apiFetch<AppAccess[]>(`/v1/apps/${appId}/access`, { token });
}
