"use server";

import { auth } from "@clerk/nextjs/server";
import { apiFetch } from "../../../lib/api";
import type { WorkspaceDeletePreview } from "../../../lib/api-types";

export async function fetchDeletePreview(): Promise<
  { preview: WorkspaceDeletePreview } | { error: string }
> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) return { error: "not_authenticated" };

  try {
    const preview = await apiFetch<WorkspaceDeletePreview>(
      "/v1/workspace/delete-preview",
      { token },
    );
    return { preview };
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    return { error: code ?? "fetch_failed" };
  }
}

export async function deleteWorkspace(
  confirmName: string,
): Promise<{ error?: string }> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) return { error: "not_authenticated" };

  try {
    await apiFetch("/v1/workspace", {
      method: "DELETE",
      body: { confirm_name: confirmName },
      token,
    });
    return {};
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    return { error: code ?? "delete_failed" };
  }
}
